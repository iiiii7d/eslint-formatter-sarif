import type { ESLint, Linter } from "eslint";
import type * as Sarif from "sarif";
import * as path from "node:path";

// Get ESLint version dynamically
async function getEslintVersion(): Promise<string> {
  try {
    const packageJson = (await import("eslint/package.json")).default;
    return packageJson.version;
  } catch {
    return "unknown";
  }
}

// Map ESLint severity to SARIF level
function mapSeverity(severity: number): Sarif.Result.level {
  switch (severity) {
    case 2:
      return "error";
    case 1:
      return "warning";
    default:
      return "none";
  }
}

// Map ESLint fix to SARIF Fix
function mapFix(
  filePath: string,
  fix: NonNullable<Linter.LintMessage["fix"]>,
): Sarif.Fix {
  return {
    artifactChanges: [
      {
        artifactLocation: {
          uri: path.relative(process.cwd(), filePath),
        },
        replacements: [
          {
            deletedRegion: {
              startLine: fix.range[0],
              startColumn: 1,
              endLine: fix.range[0],
              endColumn: fix.range[1],
            },
            insertedContent: {
              text: fix.text,
            },
          },
        ],
      },
    ],
  };
}

// Map ESLint LintResult to multiple SARIF Results (one per message)
function mapLintResultToResult(lintResult: ESLint.LintResult): Sarif.Result[] {
  return lintResult.messages.map((message) => {
    const sarifResult: Sarif.Result = {
      ruleId: message.ruleId || "unknown",
      message: {
        text: message.message,
      },
      locations: [],
      level: mapSeverity(message.severity),
    };

    // Add location for this message
    sarifResult.locations!.push({
      physicalLocation: {
        artifactLocation: {
          uri: path.relative(process.cwd(), lintResult.filePath),
        },
        region: {
          startLine: message.line,
          startColumn: message.column,
          endLine: message.endLine || message.line,
          endColumn: message.endColumn || message.column,
        },
      },
      message: {
        text: message.message,
      },
      properties: {
        messageId: message.messageId || "",
      },
    });

    // Add fix information if available
    if (message.fix) {
      sarifResult.fixes = [mapFix(lintResult.filePath, message.fix)];
    }

    return sarifResult;
  });
}

// Map ESLint rulesMeta to SARIF ReportingDescriptor
function mapRulesToReportingDescriptors(
  rulesMeta: ESLint.LintResultData["rulesMeta"],
): Sarif.ReportingDescriptor[] {
  return Object.entries(rulesMeta).map(([ruleId, ruleMeta]) => ({
    id: ruleId,
    name: ruleMeta.type,
    shortDescription: {
      text: ruleMeta.docs?.description || "No description available",
    },
    help: {
      text: ruleMeta.docs?.description || "",
    },
    helpUri: ruleMeta.docs?.url,
    defaultConfiguration: {
      level: "warning",
    },
    messageStrings: ruleMeta.messages
      ? Object.fromEntries(
          Object.entries(ruleMeta.messages).map(([k, v]) => [k, { text: v }]),
        )
      : undefined,
    properties: {
      type: ruleMeta.type,
      fixable: ruleMeta.fixable || "",
      recommended: ruleMeta.docs?.recommended || false,
    },
  }));
}

// Main formatter function
// eslint-disable-next-line max-lines-per-function
export default async function formatter(
  results: ESLint.LintResult[],
  context: ESLint.LintResultData,
): Promise<string> {
  const eslintVersion = await getEslintVersion();

  // Convert results - each LintResult can produce multiple SARIF Results
  const sarifResults: Sarif.Result[] = results.flatMap((lintResult) =>
    mapLintResultToResult(lintResult),
  );

  // Map rules to reporting descriptors
  const rulesDescriptors = mapRulesToReportingDescriptors(context.rulesMeta);

  // Build invocation information
  const invocations: Sarif.Invocation[] = [
    {
      commandLine: process.argv.join(" "),
      executionSuccessful: true,
      startTimeUtc: new Date().toISOString(),
      endTimeUtc: new Date().toISOString(),
    },
  ];

  // Build SARIF Log
  const sarifLog: Sarif.Log = {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "ESLint",
            fullName: "ESLint",
            semanticVersion: eslintVersion,
            shortDescription: {
              text: "An AST-based JavaScript linter.",
            },
            informationUri: "https://eslint.org",
            organization: "eslint",
            rules: rulesDescriptors,
            properties: {
              version: eslintVersion,
            },
          },
        },
        results: sarifResults,
        invocations,
        properties: {
          columnKind: "utf16CodeUnits",
        },
      },
    ],
    properties: {
      eslintResultsCount: results.length,
      eslintErrorCount: results.reduce(
        (sum, result) => sum + result.errorCount,
        0,
      ),
      eslintWarningCount: results.reduce(
        (sum, result) => sum + result.warningCount,
        0,
      ),
    },
  };

  return JSON.stringify(sarifLog, null, 2);
}
