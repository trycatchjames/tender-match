import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import TurndownService from "turndown";

const BASE_URL = "https://www.tenders.gov.au";
const LIST_URL = `${BASE_URL}/atm`;
const DEFAULT_OUTPUT_DIR = "output/atms";
const DEFAULT_CACHE_DIR = ".cache/scraped-atms";
const DEFAULT_DOWNLOAD_DIR = "output/downloads";
const DEFAULT_PROFILE_DIR = ".playwright-profile";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type CliOptions = {
  outDir: string;
  limit?: number;
  pageLimit?: number;
  delayMs: number;
  headful: boolean;
  downloadsDir: string;
  cacheDir: string;
  profileDir?: string;
  startUrl: string;
  refreshExisting: boolean;
};

type ListSummary = {
  currentPage: number;
  totalPages?: number;
  totalRecords?: number;
  links: TenderLink[];
};

type TenderLink = {
  url: string;
  atmId: string;
};

type DetailField = {
  label: string;
  html: string;
  text: string;
};

type TenderDetail = {
  url: string;
  pageTitle: string;
  title: string;
  contact?: string;
  actions: TenderAction[];
  fields: DetailField[];
};

type TenderAction = {
  label: string;
  url: string;
};

type TenderOutputItem = {
  fileName: string;
  title: string;
  markdown: string;
};

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

turndown.addRule("lineBreak", {
  filter: "br",
  replacement: () => "\n",
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.downloadsDir, { recursive: true });
  await mkdir(options.outDir, { recursive: true });
  await mkdir(options.cacheDir, { recursive: true });
  const browserSession = await createBrowserSession(options);

  try {
    const page = await newPage(browserSession.context);
    const links = await collectTenderLinks(page, options);
    const selectedLinks =
      options.limit === undefined ? links : links.slice(0, options.limit);

    console.log(`Found ${links.length} ATM detail links.`);
    if (selectedLinks.length !== links.length) {
      console.log(`Scraping first ${selectedLinks.length} due to --limit.`);
    }

    const scrapedAt = new Date();
    const items: TenderOutputItem[] = [];
    const usedFileNames = new Set<string>();
    let scrapedCount = 0;
    let cachedCount = 0;

    for (const [index, link] of selectedLinks.entries()) {
      const fileName = uniqueFileName(fileNameForLink(link), usedFileNames);
      const cachedPath = options.refreshExisting
        ? undefined
        : await findCachedTenderFile(fileName, [options.cacheDir, options.outDir]);

      if (cachedPath) {
        const markdown = await readFile(cachedPath, "utf8");
        await seedCacheIfNeeded(cachedPath, path.join(options.cacheDir, fileName));
        items.push({
          fileName,
          title: extractMarkdownTitle(markdown) ?? link.atmId,
          markdown,
        });
        cachedCount += 1;
        console.log(
          `[${index + 1}/${selectedLinks.length}] Skipping ${link.atmId}; already scraped`,
        );
        continue;
      }

      console.log(`[${index + 1}/${selectedLinks.length}] Scraping ${link.atmId}`);
      const detailPage = await newPage(browserSession.context);
      try {
        const detail = await scrapeTenderDetail(detailPage, link.url);
        const markdown = renderTenderMarkdown(detail, {
          index: index + 1,
          sourceUrl: options.startUrl,
          scrapedAt,
        });
        const title = detail.title || getFieldText(detail, "ATM ID") || detail.pageTitle || detail.url;
        await writeFile(path.join(options.cacheDir, fileName), markdown, "utf8");
        items.push({ fileName, title, markdown });
        scrapedCount += 1;
      } finally {
        await detailPage.close();
      }
      await sleep(options.delayMs);
    }

    await writeTenderFiles(items, {
      outDir: options.outDir,
      sourceUrl: options.startUrl,
      totalDiscovered: links.length,
      newlyScraped: scrapedCount,
      cacheHits: cachedCount,
      scrapedAt: new Date(),
    });
  } finally {
    await browserSession.close();
  }
}

type BrowserSession = {
  context: BrowserContext;
  close: () => Promise<void>;
};

async function createBrowserSession(options: CliOptions): Promise<BrowserSession> {
  if (options.profileDir) {
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless: !options.headful,
      acceptDownloads: true,
      downloadsPath: options.downloadsDir,
      ...browserContextOptions(),
    });

    return {
      context,
      close: () => context.close(),
    };
  }

  const browser = await chromium.launch({
    headless: !options.headful,
    downloadsPath: options.downloadsDir,
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    ...browserContextOptions(),
  });

  return {
    context,
    close: () => browser.close(),
  };
}

function browserContextOptions() {
  return {
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: {
      "Accept-Language": "en-AU,en;q=0.9",
    },
  };
}

async function newPage(context: BrowserContext) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(60_000);
  return page;
}

async function collectTenderLinks(page: Page, options: CliOptions) {
  const seen = new Map<string, TenderLink>();
  let totalPages: number | undefined;

  for (let pageNumber = 1; ; pageNumber += 1) {
    if (options.pageLimit !== undefined && pageNumber > options.pageLimit) {
      break;
    }

    const pageUrl = pageNumber === 1 ? options.startUrl : withPage(options.startUrl, pageNumber);
    await gotoWithRetry(page, pageUrl, ".listInner");

    const summary = await scrapeListPage(page, pageNumber);
    for (const link of summary.links) {
      seen.set(link.url, link);
    }

    totalPages ??= summary.totalPages;
    console.log(
      `List page ${pageNumber}${totalPages ? `/${totalPages}` : ""}: ${summary.links.length} links`,
    );

    if (totalPages !== undefined && pageNumber >= totalPages) {
      break;
    }

    if (totalPages === undefined) {
      const hasNextPage = await page
        .locator(`a[href*="page=${pageNumber + 1}"]`)
        .first()
        .count();
      if (hasNextPage === 0) {
        break;
      }
    }

    await sleep(options.delayMs);
  }

  return [...seen.values()];
}

async function scrapeListPage(page: Page, currentPage: number): Promise<ListSummary> {
  return page.evaluate(
    ({ baseUrl, currentPage }) => {
      const bodyText = document.body.innerText;
      const showingMatch = bodyText.match(/Showing\s+(\d+)-(\d+)\s+of\s+(\d+)\s+records/i);
      const pageStart = showingMatch ? Number(showingMatch[1]) : undefined;
      const pageEnd = showingMatch ? Number(showingMatch[2]) : undefined;
      const totalRecords = showingMatch ? Number(showingMatch[3]) : undefined;
      const pageSize =
        pageStart !== undefined && pageEnd !== undefined ? pageEnd - pageStart + 1 : undefined;
      const totalPages =
        totalRecords !== undefined && pageSize !== undefined
          ? Math.ceil(totalRecords / pageSize)
          : undefined;

      const byUrl = new Map<string, TenderLink>();
      document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
        const url = new URL(anchor.getAttribute("href") ?? "", baseUrl);
        const pathname = url.pathname.toLowerCase();
        if (!pathname.startsWith("/atm/show/") && !pathname.startsWith("/advert/show/")) {
          return;
        }

        const href = url.href;
        const atmId = anchor.textContent?.trim() ?? "";
        const existing = byUrl.get(href);
        if (!existing) {
          byUrl.set(href, { url: href, atmId: /^Full Details$/i.test(atmId) ? href : atmId || href });
          return;
        }

        if ((!existing.atmId || existing.atmId === href) && atmId && !/^Full Details$/i.test(atmId)) {
          byUrl.set(href, { url: href, atmId });
        }
      });

      return {
        currentPage,
        totalPages,
        totalRecords,
        links: [...byUrl.values()],
      };
    },
    { baseUrl: BASE_URL, currentPage },
  );
}

async function scrapeTenderDetail(page: Page, url: string): Promise<TenderDetail> {
  await gotoWithRetry(page, url, ".listInner .list-desc");

  return page.evaluate(() => {
    const absoluteHref = (href: string) => new URL(href, window.location.href).href;

    const normalize = (value: string) =>
      value
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    const cloneHtmlWithAbsoluteLinks = (element: Element) => {
      const clone = element.cloneNode(true) as Element;
      clone.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
        anchor.href = absoluteHref(anchor.getAttribute("href") ?? "");
      });
      return clone.innerHTML;
    };

    const fields = Array.from(document.querySelectorAll<HTMLElement>(".listInner .list-desc"))
      .map((row) => {
        const labelElement = Array.from(row.children).find(
          (child) => child.tagName.toLowerCase() === "span",
        );
        const valueElement = Array.from(row.children).find((child) =>
          child.classList.contains("list-desc-inner"),
        );
        const label = normalize(labelElement?.textContent ?? "").replace(/:$/, "");
        const text = normalize((valueElement as HTMLElement | undefined)?.innerText ?? "");
        const html = valueElement ? cloneHtmlWithAbsoluteLinks(valueElement) : "";
        return { label, html, text };
      })
      .filter((field) => field.label);

    const contactElement =
      document.querySelector<HTMLElement>(".pc .contact-long") ??
      document.querySelector<HTMLElement>(".contact-long");

    const actionsByUrl = new Map<string, TenderAction>();
    document.querySelectorAll<HTMLAnchorElement>(".pc .btn-actions a[href], .btn-actions a[href]").forEach(
      (anchor) => {
        const label = normalize(anchor.textContent ?? "");
        const actionUrl = absoluteHref(anchor.getAttribute("href") ?? "");
        if (label && !actionsByUrl.has(actionUrl)) {
          actionsByUrl.set(actionUrl, { label, url: actionUrl });
        }
      },
    );

    return {
      url: window.location.href,
      pageTitle: document.title,
      title: normalize(document.querySelector<HTMLElement>(".col-sm-4 .lead")?.innerText ?? ""),
      contact: normalize(contactElement?.innerText ?? ""),
      actions: [...actionsByUrl.values()],
      fields,
    };
  });
}

async function gotoWithRetry(page: Page, url: string, readySelector?: string) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await page.goto(url, { waitUntil: "load" });
      const status = response?.status();
      if (status !== undefined && status >= 400) {
        throw new Error(`HTTP ${status} loading ${url}`);
      }

      const title = await page.title();
      const body = await page.locator("body").innerText({ timeout: 10_000 });
      if (!title.trim() && !body.trim()) {
        throw new Error(`Empty page loading ${url}`);
      }

      if (/403 ERROR|request could not be satisfied/i.test(`${title}\n${body}`)) {
        throw new Error(`Blocked by upstream server at ${url}`);
      }

      if (readySelector) {
        await page.waitForSelector(readySelector, { timeout: 30_000 });
      }

      return;
    } catch (error) {
      lastError = error;
      const backoffMs = attempt <= 3 ? 2_000 * attempt : 10_000 * (attempt - 2);
      console.warn(`Retrying ${url} after navigation failure (${attempt}/6): ${messageFor(error)}`);
      await sleep(backoffMs);
    }
  }

  throw lastError;
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function writeTenderFiles(
  items: TenderOutputItem[],
  meta: {
    outDir: string;
    sourceUrl: string;
    totalDiscovered: number;
    newlyScraped: number;
    cacheHits: number;
    scrapedAt: Date;
  },
) {
  await mkdir(meta.outDir, { recursive: true });
  await cleanGeneratedMarkdown(meta.outDir);

  const indexLines: string[] = [
    "---",
    `source_url: ${yamlString(meta.sourceUrl)}`,
    `scraped_at: ${yamlString(meta.scrapedAt.toISOString())}`,
    `items_scraped: ${items.length}`,
    `items_newly_scraped: ${meta.newlyScraped}`,
    `items_from_cache: ${meta.cacheHits}`,
    `items_discovered: ${meta.totalDiscovered}`,
    "---",
    "",
    "# AusTender Current ATM Items",
    "",
    `Source: ${meta.sourceUrl}`,
    `Scraped at: ${meta.scrapedAt.toISOString()}`,
    `Items scraped: ${items.length}`,
    `Items newly scraped: ${meta.newlyScraped}`,
    `Items from cache: ${meta.cacheHits}`,
    `Items discovered: ${meta.totalDiscovered}`,
    "",
  ];

  for (const item of items) {
    const filePath = path.join(meta.outDir, item.fileName);
    await writeFile(filePath, item.markdown, "utf8");
    indexLines.push(`- [${plainInline(item.title)}](./${encodeMarkdownLinkPath(item.fileName)})`);
  }

  await writeFile(path.join(meta.outDir, "index.md"), `${indexLines.join("\n").trim()}\n`, "utf8");
  console.log(
    `Wrote ${items.length} item files plus index.md to ${meta.outDir} (${meta.newlyScraped} scraped, ${meta.cacheHits} cached)`,
  );
}

function renderTenderMarkdown(
  detail: TenderDetail,
  meta: { index: number; sourceUrl: string; scrapedAt: Date },
) {
  const heading = detail.title || getFieldText(detail, "ATM ID") || detail.pageTitle || detail.url;
  const atmId = getFieldText(detail, "ATM ID") ?? "";
  const lines: string[] = [
    "---",
    `title: ${yamlString(heading)}`,
    `atm_id: ${yamlString(atmId)}`,
    `url: ${yamlString(detail.url)}`,
    `source_url: ${yamlString(meta.sourceUrl)}`,
    `scraped_at: ${yamlString(meta.scrapedAt.toISOString())}`,
    `list_position: ${meta.index}`,
    "---",
    "",
    `# ${plainInline(heading)}`,
    "",
    `Source list: ${meta.sourceUrl}`,
    `Detail URL: ${detail.url}`,
    `Scraped at: ${meta.scrapedAt.toISOString()}`,
    `List position: ${meta.index}`,
    "",
  ];

  if (detail.actions.length > 0) {
    lines.push(
      `Actions: ${detail.actions.map((action) => `[${action.label}](${action.url})`).join(" | ")}`,
      "",
    );
  }

  if (detail.contact) {
    lines.push("## Contact Details", "", markdownFromText(cleanContact(detail.contact)), "");
  }

  for (const field of detail.fields) {
    appendField(lines, field);
  }

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

function appendField(lines: string[], field: DetailField) {
  const markdown = markdownFromHtml(field.html, field.text);
  if (!markdown) {
    return;
  }

  const isSingleLine = !markdown.includes("\n") && markdown.length <= 180;
  if (isSingleLine) {
    lines.push(`- **${plainInline(field.label)}:** ${markdown}`, "");
    return;
  }

  lines.push(`## ${plainInline(field.label)}`, "", markdown, "");
}

function markdownFromHtml(html: string, fallbackText: string) {
  const markdown = turndown
    .turndown(html || fallbackText)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return markdown || markdownFromText(fallbackText);
}

function markdownFromText(text: string) {
  return text
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getFieldText(detail: TenderDetail, label: string) {
  return detail.fields.find((field) => field.label.toLowerCase() === label.toLowerCase())?.text;
}

function cleanContact(contact: string) {
  return contact
    .split("\n")
    .filter((line, index) => index !== 0 || line.trim().toLowerCase() !== "contact details")
    .join("\n")
    .trim();
}

function fileNameForDetail(detail: TenderDetail) {
  const atmId = getFieldText(detail, "ATM ID") ?? "";
  const base = slugify(atmId) || slugify(detail.title) || "atm";
  return `${base}.md`;
}

function fileNameForLink(link: TenderLink) {
  return `${slugify(link.atmId) || slugify(link.url) || "atm"}.md`;
}

function uniqueFileName(fileName: string, usedFileNames: Set<string>) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, -ext.length);
  let candidate = fileName;
  let suffix = 2;

  while (usedFileNames.has(candidate)) {
    candidate = `${base}-${suffix}${ext}`;
    suffix += 1;
  }

  usedFileNames.add(candidate);
  return candidate;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
}

function encodeMarkdownLinkPath(fileName: string) {
  return fileName
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function cleanGeneratedMarkdown(outDir: string) {
  const entries = await readdir(outDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => rm(path.join(outDir, entry.name))),
  );
}

async function findCachedTenderFile(fileName: string, dirs: string[]) {
  for (const dir of dirs) {
    const filePath = path.join(dir, fileName);
    if (await exists(filePath)) {
      return filePath;
    }
  }

  return undefined;
}

async function seedCacheIfNeeded(sourcePath: string, targetPath: string) {
  if (sourcePath === targetPath || (await exists(targetPath))) {
    return;
  }

  await copyFile(sourcePath, targetPath);
}

async function exists(filePath: string) {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function extractMarkdownTitle(markdown: string) {
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/);
  const titleLine = frontmatter?.[1].match(/^title:\s*(.+)$/m)?.[1];
  if (titleLine) {
    const trimmed = titleLine.trim();
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      return trimmed.replace(/^["']|["']$/g, "").trim();
    }
  }

  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function withPage(url: string, pageNumber: number) {
  const next = new URL(url);
  next.searchParams.set("page", String(pageNumber));
  return next.href;
}

function plainInline(value: string) {
  return value.replace(/\s+/g, " ").replace(/[#*_`[\]]/g, "").trim();
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    outDir: DEFAULT_OUTPUT_DIR,
    delayMs: 500,
    headful: false,
    downloadsDir: DEFAULT_DOWNLOAD_DIR,
    cacheDir: DEFAULT_CACHE_DIR,
    profileDir: DEFAULT_PROFILE_DIR,
    startUrl: LIST_URL,
    refreshExisting: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--out":
        assertValue(arg, next);
        options.outDir = next;
        index += 1;
        break;
      case "--limit":
        assertValue(arg, next);
        options.limit = toPositiveInt(arg, next);
        index += 1;
        break;
      case "--page-limit":
        assertValue(arg, next);
        options.pageLimit = toPositiveInt(arg, next);
        index += 1;
        break;
      case "--delay":
        assertValue(arg, next);
        options.delayMs = toNonNegativeInt(arg, next);
        index += 1;
        break;
      case "--headful":
        options.headful = true;
        break;
      case "--profile":
        assertValue(arg, next);
        options.profileDir = next;
        index += 1;
        break;
      case "--no-profile":
        options.profileDir = undefined;
        break;
      case "--downloads":
        assertValue(arg, next);
        options.downloadsDir = next;
        index += 1;
        break;
      case "--cache":
        assertValue(arg, next);
        options.cacheDir = next;
        index += 1;
        break;
      case "--start-url":
        assertValue(arg, next);
        options.startUrl = next;
        index += 1;
        break;
      case "--refresh":
        options.refreshExisting = true;
        break;
      case "--help":
      case "-h":
        printHelpAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function assertValue(arg: string, value: string | undefined): asserts value is string {
  if (!value || value.startsWith("--")) {
    throw new Error(`Expected a value after ${arg}`);
  }
}

function toPositiveInt(arg: string, value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${arg} must be a positive integer`);
  }
  return parsed;
}

function toNonNegativeInt(arg: string, value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${arg} must be a non-negative integer`);
  }
  return parsed;
}

function printHelpAndExit(): never {
  console.log(`Usage: npm run scrape -- [options]

Options:
  --out <dir>          Markdown output directory (default: ${DEFAULT_OUTPUT_DIR})
  --profile <dir>      Persistent browser profile directory (default: ${DEFAULT_PROFILE_DIR})
  --no-profile         Use a temporary browser session instead of a persistent profile
  --downloads <dir>    Download directory for browser downloads (default: ${DEFAULT_DOWNLOAD_DIR})
  --cache <dir>        Scraped tender cache directory (default: ${DEFAULT_CACHE_DIR})
  --limit <count>      Scrape only the first N detail pages
  --page-limit <count> Crawl only the first N list pages
  --delay <ms>         Delay between browser requests (default: 500)
  --headful            Show the Chromium browser while scraping
  --start-url <url>    AusTender ATM list URL to start from (default: ${LIST_URL})
  --refresh            Re-scrape detail pages even when cached files exist
`);
  process.exit(0);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
