import { CompletionProvider } from "core/autocomplete/CompletionProvider";
import { processSingleLineCompletion } from "core/autocomplete/util/processSingleLineCompletion";
import {
  type AutocompleteInput,
  type AutocompleteOutcome,
} from "core/autocomplete/util/types";
import { ConfigHandler } from "core/config/ConfigHandler";
import { IS_NEXT_EDIT_ACTIVE } from "core/nextEdit/constants";
import { NextEditProvider } from "core/nextEdit/NextEditProvider";
import { v4 as uuidv4 } from "uuid";
import * as vscode from "vscode";

import { handleLLMError } from "../util/errorHandling";
import { VsCodeIde } from "../VsCodeIde";
import { VsCodeWebviewProtocol } from "../webviewProtocol";

import { getDefinitionsFromLsp } from "./lsp";
import { RecentlyEditedTracker } from "./recentlyEdited";
import { RecentlyVisitedRangesService } from "./RecentlyVisitedRangesService";
import {
  StatusBarStatus,
  getStatusBarStatus,
  setupStatusBar,
  stopStatusBarLoading,
} from "./statusBar";

interface VsCodeCompletionInput {
  document: vscode.TextDocument;
  position: vscode.Position;
  context: vscode.InlineCompletionContext;
}

export class ContinueCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  private async onError(e: unknown) {
    if (await handleLLMError(e)) {
      return;
    }
    let message = "Continue Autocomplete Error";
    if (e instanceof Error) {
      message += `: ${e.message}`;
    }
    vscode.window.showErrorMessage(message, "Documentation").then((val) => {
      if (val === "Documentation") {
        vscode.env.openExternal(
          vscode.Uri.parse(
            "https://docs.continue.dev/features/tab-autocomplete",
          ),
        );
      }
    });
  }

  private completionProvider: CompletionProvider;
  private nextEditProvider: NextEditProvider | undefined;
  private recentlyVisitedRanges: RecentlyVisitedRangesService;
  private recentlyEditedTracker: RecentlyEditedTracker;

  constructor(
    private readonly configHandler: ConfigHandler,
    private readonly ide: VsCodeIde,
    private readonly webviewProtocol: VsCodeWebviewProtocol,
  ) {
    this.recentlyEditedTracker = new RecentlyEditedTracker(ide.ideUtils);

    async function getAutocompleteModel() {
      const { config } = await configHandler.loadConfig();
      if (!config) {
        return;
      }
      return config.selectedModelByRole.autocomplete ?? undefined;
    }
    this.completionProvider = new CompletionProvider(
      this.configHandler,
      this.ide,
      getAutocompleteModel,
      this.onError.bind(this),
      getDefinitionsFromLsp,
    );
    // NOTE: Only turn it on locally when testing (for review purposes).
    if (IS_NEXT_EDIT_ACTIVE) {
      this.nextEditProvider = new NextEditProvider(
        this.configHandler,
        this.ide,
        getAutocompleteModel,
        this.onError.bind(this),
        getDefinitionsFromLsp,
      );
    }
    this.recentlyVisitedRanges = new RecentlyVisitedRangesService(ide);
  }

  _lastShownCompletion: AutocompleteOutcome | undefined;

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
    //@ts-ignore
  ): ProviderResult<InlineCompletionItem[] | InlineCompletionList> {
    const enableTabAutocomplete =
      getStatusBarStatus() === StatusBarStatus.Enabled;
    if (token.isCancellationRequested || !enableTabAutocomplete) {
      return null;
    }

    if (document.uri.scheme === "vscode-scm") {
      return null;
    }

    // Don't autocomplete with multi-cursor
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.selections.length > 1) {
      return null;
    }

    const selectedCompletionInfo = context.selectedCompletionInfo;

    // This code checks if there is a selected completion suggestion in the given context and ensures that it is valid
    // To improve the accuracy of suggestions it checks if the user has typed at least 4 characters
    // This helps refine and filter out irrelevant autocomplete options
    if (selectedCompletionInfo) {
      const { text, range } = selectedCompletionInfo;
      const typedText = document.getText(range);

      const typedLength = range.end.character - range.start.character;

      if (typedLength < 4) {
        return null;
      }

      if (!text.startsWith(typedText)) {
        return null;
      }
    }
    let injectDetails: string | undefined = undefined;

    try {
      const abortController = new AbortController();
      const signal = abortController.signal;
      token.onCancellationRequested(() => abortController.abort());

      // Handle commit message input box
      let manuallyPassPrefix: string | undefined = undefined;

      // Only use the current file's context: do not include notebook, untitled, or other file context
      const pos = {
        line: position.line,
        character: position.character,
      };

      const input: AutocompleteInput = {
        pos,
        manuallyPassFileContents: undefined,
        manuallyPassPrefix: undefined,
        selectedCompletionInfo,
        injectDetails,
        isUntitledFile: document.isUntitled,
        completionId: uuidv4(),
        filepath: document.uri.toString(),
        recentlyVisitedRanges: [],
        recentlyEditedRanges: [],
      };

      setupStatusBar(undefined, true);
      const outcome =
        await this.completionProvider.provideInlineCompletionItems(
          input,
          signal,
        );

      if (!outcome || !outcome.completion) {
        return null;
      }

      // NOTE: This is a very rudimentary check to see if we can call the next edit service.
      // In the future we will have to figure out how to call this more gracefully.
      if (this.nextEditProvider) {
        const nextEditOutcome =
          await this.nextEditProvider?.provideInlineCompletionItems(
            input,
            signal,
          );

        if (nextEditOutcome && nextEditOutcome.completion) {
          outcome.completion = nextEditOutcome.completion;
        }
      }

      // VS Code displays dependent on selectedCompletionInfo (their docstring below)
      // We should first always make sure we have a valid completion, but if it goes wrong we
      // want telemetry to be correct
      /**
       * Provides information about the currently selected item in the autocomplete widget if it is visible.
       *
       * If set, provided inline completions must extend the text of the selected item
       * and use the same range, otherwise they are not shown as preview.
       * As an example, if the document text is `console.` and the selected item is `.log` replacing the `.` in the document,
       * the inline completion must also replace `.` and start with `.log`, for example `.log()`.
       *
       * Inline completion providers are requested again whenever the selected item changes.
       */
      if (selectedCompletionInfo) {
        outcome.completion = selectedCompletionInfo.text + outcome.completion;
      }
      const willDisplay = this.willDisplay(
        document,
        selectedCompletionInfo,
        signal,
        outcome,
      );
      if (!willDisplay) {
        return null;
      }

      // Mark displayed
      this.completionProvider.markDisplayed(input.completionId, outcome);
      this._lastShownCompletion = outcome;      // Construct the range/text to show
      const startPos = selectedCompletionInfo?.range.start ?? position;
      let range = new vscode.Range(startPos, startPos);
      let completionText = extractCodeFromMarkdownBlock(outcome.completion);
      
      // Get the current line and calculate base indentation
      const currentLine = document.lineAt(startPos.line);
      const currentLineText = currentLine.text;
      const baseIndentation = currentLineText.substring(0, startPos.character);
      
      console.log("Context")
      console.log(completionText)
      const isSingleLineCompletion = completionText.split("\n").length <= 1;

      if (isSingleLineCompletion) {
        const lastLineOfCompletionText = completionText.split("\n").pop() || "";
        const currentText = document
          .lineAt(startPos)
          .text.substring(startPos.character);

        const result = processSingleLineCompletion(
          lastLineOfCompletionText,
          currentText,
          startPos.character,
        );

        if (result === undefined) {
          return undefined;
        }        completionText = result.completionText;
        if (result.range) {
          range = new vscode.Range(
            new vscode.Position(startPos.line, result.range.start),
            new vscode.Position(startPos.line, result.range.end),
          );
        }
      } else {
        // Handle multi-line completions with proper indentation
        const lines = completionText.split("\n");
        
        if (lines.length > 1) {
          // Calculate the indentation of the first line
          const firstLine = lines[0];
          const firstLineIndentation = firstLine.match(/^\s*/)?.[0] || "";
          
          // For multi-line completions, we need to align the first line to cursor
          // and indent subsequent lines relative to the first line and cursor
          const indentedLines = lines.map((line, index) => {
            if (index === 0) {
              // First line: remove its original indentation and use cursor position
              const firstLineContent = firstLine.substring(firstLineIndentation.length);
              return firstLineContent;
            } else {
              // For subsequent lines, preserve relative indentation from first line
              if (line.trim() === "") {
                // Keep empty lines empty
                return "";
              } else {
                // Calculate relative indentation compared to first line
                const lineIndentation = line.match(/^\s*/)?.[0] || "";
                const lineContent = line.substring(lineIndentation.length);
                
                // Calculate the relative indent (how much more/less than first line)
                const relativeIndent = lineIndentation.length - firstLineIndentation.length;
                
                // Apply base indentation + first line indentation + relative indentation
                const totalIndentSpaces = Math.max(0, baseIndentation.length + relativeIndent);
                const totalIndent = " ".repeat(totalIndentSpaces);
                
                return totalIndent + lineContent;
              }
            }
          });
          
          completionText = indentedLines.join("\n");
        }
        
        // Extend the range to the end of the line for multiline completions
        range = new vscode.Range(startPos, document.lineAt(startPos).range.end);
      }
      console.log("Multi line")
      console.log(completionText)
      const completionItem = new vscode.InlineCompletionItem(
        completionText,
        range,
        {
          title: "Log Autocomplete Outcome",
          command: "continue.logAutocompleteOutcome",
          arguments: [input.completionId, this.completionProvider],
        },
      );

      (completionItem as any).completeBracketPairs = true;
      return [completionItem];
    } finally {
      stopStatusBarLoading();
    }
  }

  willDisplay(
    document: vscode.TextDocument,
    selectedCompletionInfo: vscode.SelectedCompletionInfo | undefined,
    abortSignal: AbortSignal,
    outcome: AutocompleteOutcome,
  ): boolean {
    if (selectedCompletionInfo) {
      const { text, range } = selectedCompletionInfo;
      if (!outcome.completion.startsWith(text)) {
        console.log(
          `Won't display completion because text doesn't match: ${text}, ${outcome.completion}`,
          range,
        );
        return false;
      }
    }

    if (abortSignal.aborted) {
      return false;
    }

    return true;
  }
}
function extractCodeFromMarkdownBlock(text: string): string {
  // Try to match a complete code block first
  const completeMatch = text.match(/```(?:\w*\n)?([\s\S]*?)```/);
  if (completeMatch) {
    return completeMatch[1];
  }

  // If there's an unclosed code block, extract everything after the opening ```
  const unclosedMatch = text.match(/```(?:\w*\n)?([\s\S]*)$/);
  if (unclosedMatch) {
    return unclosedMatch[1];
  }

  // No code block found, return original text
  return text;
}
