import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  rename,
  stat,
} from "node:fs/promises";
import path from "node:path";

const DEFAULT_NEW_DIR = "output/new";
const DEFAULT_SHORTLIST_DIR = "output/shortlist";
const REVIEW_FIT_DIRS = ["good-fit", "medium-fit"] as const;

type ReviewFit = (typeof REVIEW_FIT_DIRS)[number];

type CliOptions = {
  newDir: string;
  shortlistDir: string;
};

type ReviewItem = {
  fit: ReviewFit;
  fileName: string;
  sourcePath: string;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = resolvePaths(options);

  await ensureReviewDirs(paths.newDirs);
  await ensureReviewDirs(paths.shortlistDirs);

  const items = await listReviewItems(paths.newDirs);
  if (items.length === 0) {
    console.log(`No new medium/good tenders to review in ${paths.newRoot}.`);
    return;
  }

  const rl = createInterface({ input, output });
  const counts = {
    kept: 0,
    discarded: 0,
    skipped: 0,
  };

  try {
    for (const [index, item] of items.entries()) {
      const markdown = await readFile(item.sourcePath, "utf8");
      const summary = summarizeTender(markdown);

      printItem({
        item,
        index: index + 1,
        total: items.length,
        title: summary.title,
        description: summary.description,
      });

      const action = await promptForAction(rl);
      if (action === "quit") {
        counts.skipped += items.length - index;
        break;
      }

      if (action === "skip") {
        counts.skipped += 1;
        continue;
      }

      if (action === "discard") {
        await rm(item.sourcePath);
        counts.discarded += 1;
        console.log(`Discarded ${item.fileName}.`);
        continue;
      }

      await keepItem(item, paths.shortlistDirs[item.fit]);
      counts.kept += 1;
      console.log(`Kept ${item.fileName}.`);
    }
  } finally {
    rl.close();
  }

  console.log(
    [
      "Done.",
      `kept=${counts.kept}`,
      `discarded=${counts.discarded}`,
      `skipped=${counts.skipped}`,
    ].join(" "),
  );
}

function resolvePaths(options: CliOptions) {
  const cwd = process.cwd();
  const newRoot = path.resolve(cwd, options.newDir);
  const shortlistRoot = path.resolve(cwd, options.shortlistDir);
  const newDirs = Object.fromEntries(
    REVIEW_FIT_DIRS.map((dir) => [dir, path.join(newRoot, dir)]),
  ) as Record<ReviewFit, string>;
  const shortlistDirs = Object.fromEntries(
    REVIEW_FIT_DIRS.map((dir) => [dir, path.join(shortlistRoot, dir)]),
  ) as Record<ReviewFit, string>;

  return {
    newRoot,
    shortlistRoot,
    newDirs,
    shortlistDirs,
  };
}

async function ensureReviewDirs(dirs: Record<ReviewFit, string>) {
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
}

async function listReviewItems(newDirs: Record<ReviewFit, string>) {
  const items: ReviewItem[] = [];

  for (const fit of REVIEW_FIT_DIRS) {
    const entries = await readdir(newDirs[fit], { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      items.push({
        fit,
        fileName: entry.name,
        sourcePath: path.join(newDirs[fit], entry.name),
      });
    }
  }

  return items.sort(
    (a, b) =>
      REVIEW_FIT_DIRS.indexOf(a.fit) - REVIEW_FIT_DIRS.indexOf(b.fit) ||
      a.fileName.localeCompare(b.fileName),
  );
}

function summarizeTender(markdown: string) {
  return {
    title: extractTitle(markdown) ?? "Untitled tender",
    description: extractDescription(markdown) ?? "No description found.",
  };
}

function extractTitle(markdown: string) {
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/);
  const titleLine = frontmatter?.[1].match(/^title:\s*(.+)$/m)?.[1];
  if (titleLine) {
    return parseYamlString(titleLine);
  }

  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function parseYamlString(value: string) {
  const trimmed = value.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // Frontmatter in this project is JSON-compatible, but keep a plain fallback.
  }

  return trimmed.replace(/^["']|["']$/g, "").trim();
}

function extractDescription(markdown: string) {
  const match = markdown.match(
    /^## Description\s+([\s\S]*?)(?=\n(?:## |-\s+\*\*)|$)/m,
  );
  return cleanMarkdownText(match?.[1] ?? "");
}

function cleanMarkdownText(value: string) {
  const cleaned = value
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || undefined;
}

function printItem({
  item,
  index,
  total,
  title,
  description,
}: {
  item: ReviewItem;
  index: number;
  total: number;
  title: string;
  description: string;
}) {
  console.log("\n" + "-".repeat(80));
  console.log(`[${index}/${total}] ${item.fileName}`);
  console.log(`Fit: ${item.fit}`);
  console.log(`Tender: ${title}`);
  console.log("");
  console.log("Description:");
  console.log(wrapText(description, 100));
  console.log("");
}

async function promptForAction(
  rl: ReturnType<typeof createInterface>,
): Promise<"keep" | "discard" | "skip" | "quit"> {
  for (;;) {
    const answer = (await rl.question("Keep, discard, skip, quit? [k/d/s/q] "))
      .trim()
      .toLowerCase();

    switch (answer) {
      case "k":
      case "keep":
        return "keep";
      case "d":
      case "discard":
        return "discard";
      case "":
      case "s":
      case "skip":
        return "skip";
      case "q":
      case "quit":
        return "quit";
      default:
        console.log("Please enter k, d, s, or q.");
    }
  }
}

async function keepItem(item: ReviewItem, shortlistDir: string) {
  await mkdir(shortlistDir, { recursive: true });
  const targetPath = path.join(shortlistDir, item.fileName);

  if (await exists(targetPath)) {
    await rm(item.sourcePath);
    return;
  }

  try {
    await rename(item.sourcePath, targetPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EXDEV") {
      throw error;
    }

    await copyFile(item.sourcePath, targetPath);
    await rm(item.sourcePath);
  }
}

function wrapText(value: string, width: number) {
  const paragraphs = value.split(/\n{2,}/);
  return paragraphs
    .map((paragraph) => wrapParagraph(paragraph.replace(/\n/g, " "), width))
    .join("\n\n");
}

function wrapParagraph(value: string, width: number) {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) {
      lines.push(line);
      line = word;
      continue;
    }

    line = next;
  }

  if (line) {
    lines.push(line);
  }

  return lines.join("\n");
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    newDir: DEFAULT_NEW_DIR,
    shortlistDir: DEFAULT_SHORTLIST_DIR,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--new":
        assertValue(arg, next);
        options.newDir = next;
        index += 1;
        break;
      case "--shortlist":
        assertValue(arg, next);
        options.shortlistDir = next;
        index += 1;
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

function assertValue(
  arg: string,
  value: string | undefined,
): asserts value is string {
  if (!value || value.startsWith("--")) {
    throw new Error(`Expected a value after ${arg}`);
  }
}

function printHelpAndExit(): never {
  console.log(`Usage: npm run review -- [options]

Options:
  --new <dir>           Directory containing new review items (default: ${DEFAULT_NEW_DIR})
  --shortlist <dir>     Directory for kept items (default: ${DEFAULT_SHORTLIST_DIR})
`);
  process.exit(0);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
