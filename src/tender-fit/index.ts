import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { openai } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";

const DEFAULT_INPUT_DIR = "output/atms";
const DEFAULT_POSITIONING_FILE = "src/tender-fit/positioning-statement.md";
const DEFAULT_MODEL = "gpt-5.4";

const FIT_DIRS = ["bad-fit", "medium-fit", "good-fit"] as const;
const RESULT_DIRS = [...FIT_DIRS, "unclassified"] as const;
const REVIEW_FIT_DIRS = ["medium-fit", "good-fit"] as const;
const OUTPUT_ROOT = "output";

type Fit = (typeof FIT_DIRS)[number];
type ResultDir = (typeof RESULT_DIRS)[number];
type ReviewFit = (typeof REVIEW_FIT_DIRS)[number];

type CliOptions = {
  inputDir: string;
  positioningFile: string;
  model: string;
  limit?: number;
  fileName?: string;
};

type ClassificationDecision =
  | {
      kind: "classified";
      fit: Fit;
      reason: string;
    }
  | {
      kind: "unclassified";
      reason: string;
    };

const classifyContractFitInputSchema = z.object({
  fit: z
    .enum(FIT_DIRS)
    .describe(
      "The single fit bucket for this tender: bad-fit, medium-fit, or good-fit.",
    ),
  reason: z
    .string()
    .min(1)
    .describe(
      "Concise reviewer-facing rationale for why this tender belongs in that bucket.",
    ),
});

const cannotClassifyInputSchema = z.object({
  reason: z
    .string()
    .min(1)
    .describe(
      "Concise reviewer-facing explanation of what prevents classification.",
    ),
});

const classificationTools = {
  classifyContractFit: tool({
    description:
      "Use this when the tender can be classified into exactly one fit bucket for the positioning statement.",
    inputSchema: classifyContractFitInputSchema,
  }),
  cannotClassify: tool({
    description:
      "Use this when the tender cannot be classified confidently from the positioning statement and tender content.",
    inputSchema: cannotClassifyInputSchema,
  }),
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = resolvePaths(options);

  await ensureReadableFile(paths.positioningFile, "positioning statement");
  await ensureReadableDirectory(paths.inputDir, "input directory");
  await ensureOutputDirs(paths.resultDirs);
  await ensureOutputDirs(paths.newDirs);

  const [systemPrompt, promptTemplate, positioningStatement] =
    await Promise.all([
      readRequiredText(paths.systemPromptFile, "system prompt"),
      readRequiredText(paths.promptFile, "prompt template"),
      readRequiredText(paths.positioningFile, "positioning statement"),
    ]);

  const tenderFiles = await listTenderFiles(paths.inputDir);
  const selectedTenderFiles = selectTenderFiles(tenderFiles, options);

  console.log(`Found ${tenderFiles.length} tender files in ${paths.inputDir}.`);
  if (options.fileName) {
    console.log(`Classifying selected file: ${selectedTenderFiles[0]}`);
  } else if (selectedTenderFiles.length !== tenderFiles.length) {
    console.log(
      `Classifying first ${selectedTenderFiles.length} due to --limit.`,
    );
  }

  const counts: Record<ResultDir | "new" | "skipped" | "failed", number> = {
    "bad-fit": 0,
    "medium-fit": 0,
    "good-fit": 0,
    unclassified: 0,
    new: 0,
    skipped: 0,
    failed: 0,
  };

  for (const [index, fileName] of selectedTenderFiles.entries()) {
    const existing = await existingClassification(fileName, paths.resultDirs);
    if (existing) {
      counts.skipped += 1;
      console.log(
        `[${index + 1}/${selectedTenderFiles.length}] Skipping ${fileName}; already classified at ${existing}`,
      );
      continue;
    }

    console.log(
      `[${index + 1}/${selectedTenderFiles.length}] Classifying ${fileName}`,
    );

    try {
      const tenderPath = path.join(paths.inputDir, fileName);
      const tenderMarkdown = await readRequiredText(
        tenderPath,
        `tender ${fileName}`,
      );
      const prompt = renderPrompt(promptTemplate, {
        filename: fileName,
        positioningStatement,
        tenderMarkdown,
      });
      const classification = await classifyTender({
        model: options.model,
        systemPrompt,
        prompt,
      });

      await writeClassification({
        fileName,
        tenderPath,
        decision: classification,
        resultDirs: paths.resultDirs,
        newDirs: paths.newDirs,
      });

      const resultDir = resultDirForDecision(classification);
      counts[resultDir] += 1;
      if (isReviewFit(resultDir)) {
        counts.new += 1;
      }
      console.log(`  -> ${resultDir}: ${classification.reason}`);
    } catch (error) {
      counts.failed += 1;
      console.error(`  !! Failed ${fileName}: ${messageFor(error)}`);
    }
  }

  console.log(
    [
      "Done.",
      `good-fit=${counts["good-fit"]}`,
      `medium-fit=${counts["medium-fit"]}`,
      `bad-fit=${counts["bad-fit"]}`,
      `unclassified=${counts.unclassified}`,
      `new=${counts.new}`,
      `skipped=${counts.skipped}`,
      `failed=${counts.failed}`,
    ].join(" "),
  );

  if (counts.failed > 0) {
    process.exitCode = 1;
  }
}

function resolvePaths(options: CliOptions) {
  const cwd = process.cwd();
  const resultDirs = Object.fromEntries(
    RESULT_DIRS.map((dir) => [dir, path.resolve(cwd, OUTPUT_ROOT, dir)]),
  ) as Record<ResultDir, string>;
  const newDirs = Object.fromEntries(
    REVIEW_FIT_DIRS.map((dir) => [
      dir,
      path.resolve(cwd, OUTPUT_ROOT, "new", dir),
    ]),
  ) as Record<ReviewFit, string>;

  return {
    inputDir: path.resolve(cwd, options.inputDir),
    positioningFile: path.resolve(cwd, options.positioningFile),
    systemPromptFile: path.resolve(cwd, "src/tender-fit/system-prompt.md"),
    promptFile: path.resolve(cwd, "src/tender-fit/prompt.md"),
    resultDirs,
    newDirs,
  };
}

async function classifyTender({
  model,
  systemPrompt,
  prompt,
}: {
  model: string;
  systemPrompt: string;
  prompt: string;
}): Promise<ClassificationDecision> {
  const result = await generateText({
    model: openai(model),
    system: systemPrompt,
    prompt,
    tools: classificationTools,
    toolChoice: "required",
  });

  if (result.toolCalls.length !== 1) {
    throw new Error(
      `Expected exactly one tool call, received ${result.toolCalls.length}.`,
    );
  }

  const [toolCall] = result.toolCalls;
  if (toolCall.toolName === "classifyContractFit") {
    const input = classifyContractFitInputSchema.parse(toolCall.input);
    return {
      kind: "classified",
      fit: input.fit,
      reason: input.reason,
    };
  }

  if (toolCall.toolName === "cannotClassify") {
    const input = cannotClassifyInputSchema.parse(toolCall.input);
    return {
      kind: "unclassified",
      reason: input.reason,
    };
  }

  throw new Error(`Unexpected tool call: ${String(toolCall.toolName)}`);
}

async function writeClassification({
  fileName,
  tenderPath,
  decision,
  resultDirs,
  newDirs,
}: {
  fileName: string;
  tenderPath: string;
  decision: ClassificationDecision;
  resultDirs: Record<ResultDir, string>;
  newDirs: Record<ReviewFit, string>;
}) {
  const resultDir = resultDirs[resultDirForDecision(decision)];
  const targetTenderPath = path.join(resultDir, fileName);
  const targetNotesPath = path.join(resultDir, notesFileName(fileName));

  await assertDoesNotExist(targetTenderPath);
  await assertDoesNotExist(targetNotesPath);

  await copyFile(tenderPath, targetTenderPath);
  await writeFile(targetNotesPath, renderNotes(fileName, decision), "utf8");

  const decisionResultDir = resultDirForDecision(decision);
  if (isReviewFit(decisionResultDir)) {
    const newTenderPath = path.join(newDirs[decisionResultDir], fileName);
    await assertDoesNotExist(newTenderPath);
    await copyFile(tenderPath, newTenderPath);
  }
}

function renderNotes(fileName: string, decision: ClassificationDecision) {
  const lines = [
    `# ${fileName} Classification Notes`,
    "",
    `Result: ${resultDirForDecision(decision)}`,
    "",
    "## Reason",
    "",
    decision.reason.trim(),
    "",
  ];

  return `${lines
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()}\n`;
}

function resultDirForDecision(decision: ClassificationDecision): ResultDir {
  return decision.kind === "classified" ? decision.fit : "unclassified";
}

function isReviewFit(resultDir: ResultDir): resultDir is ReviewFit {
  return (REVIEW_FIT_DIRS as readonly string[]).includes(resultDir);
}

async function existingClassification(
  fileName: string,
  resultDirs: Record<ResultDir, string>,
) {
  const noteName = notesFileName(fileName);

  for (const resultDir of RESULT_DIRS) {
    const tenderPath = path.join(resultDirs[resultDir], fileName);
    if (await exists(tenderPath)) {
      return tenderPath;
    }

    const notePath = path.join(resultDirs[resultDir], noteName);
    if (await exists(notePath)) {
      return notePath;
    }
  }

  return undefined;
}

async function listTenderFiles(inputDir: string) {
  const entries = await readdir(inputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".md") && name !== "index.md")
    .sort((a, b) => a.localeCompare(b));
}

function selectTenderFiles(tenderFiles: string[], options: CliOptions) {
  if (options.fileName) {
    const fileName = normalizeTenderFileName(options.fileName);
    if (!tenderFiles.includes(fileName)) {
      throw new Error(
        `Tender file not found in ${options.inputDir}: ${fileName}`,
      );
    }
    return [fileName];
  }

  return options.limit === undefined
    ? tenderFiles
    : tenderFiles.slice(0, options.limit);
}

function normalizeTenderFileName(fileName: string) {
  return fileName.endsWith(".md") ? fileName : `${fileName}.md`;
}

async function ensureOutputDirs(resultDirs: Record<string, string>) {
  await Promise.all(
    Object.values(resultDirs).map((dir) => mkdir(dir, { recursive: true })),
  );
}

async function ensureReadableFile(filePath: string, label: string) {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`${label} is not a file: ${filePath}`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Missing ${label}: ${filePath}`);
    }
    throw error;
  }
}

async function ensureReadableDirectory(dirPath: string, label: string) {
  try {
    const stats = await stat(dirPath);
    if (!stats.isDirectory()) {
      throw new Error(`${label} is not a directory: ${dirPath}`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Missing ${label}: ${dirPath}`);
    }
    throw error;
  }
}

async function readRequiredText(filePath: string, label: string) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Missing ${label}: ${filePath}`);
    }
    throw error;
  }
}

async function assertDoesNotExist(filePath: string) {
  if (await exists(filePath)) {
    throw new Error(`Refusing to overwrite existing file: ${filePath}`);
  }
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

function notesFileName(fileName: string) {
  return `${fileName.slice(0, -path.extname(fileName).length)}-notes.md`;
}

function renderPrompt(template: string, values: Record<string, string>) {
  return template.replace(
    /{{(filename|positioningStatement|tenderMarkdown)}}/g,
    (_, key: string) => {
      return values[key] ?? "";
    },
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    inputDir: DEFAULT_INPUT_DIR,
    positioningFile: DEFAULT_POSITIONING_FILE,
    model: DEFAULT_MODEL,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--input":
        assertValue(arg, next);
        options.inputDir = next;
        index += 1;
        break;
      case "--positioning":
        assertValue(arg, next);
        options.positioningFile = next;
        index += 1;
        break;
      case "--limit":
        assertValue(arg, next);
        options.limit = toPositiveInt(arg, next);
        index += 1;
        break;
      case "--file":
        assertValue(arg, next);
        options.fileName = next;
        index += 1;
        break;
      case "--model":
        assertValue(arg, next);
        options.model = next;
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

function toPositiveInt(arg: string, value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${arg} must be a positive integer`);
  }
  return parsed;
}

function printHelpAndExit(): never {
  console.log(`Usage: npm run classify:tenders -- [options]

Options:
  --input <dir>          Tender markdown input directory (default: ${DEFAULT_INPUT_DIR})
  --positioning <file>   Positioning statement markdown file (default: ${DEFAULT_POSITIONING_FILE})
  --limit <count>        Classify only the first N unindexed tender files
  --file <filename>      Classify one tender file from the input directory
  --model <model>        OpenAI model to use through Vercel AI SDK (default: ${DEFAULT_MODEL})
`);
  process.exit(0);
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

main().catch((error: unknown) => {
  console.error(messageFor(error));
  process.exitCode = 1;
});
