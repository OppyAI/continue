import { countTokens } from "../../llm/countTokens";
import { SnippetPayload } from "../snippets";
import {
  AutocompleteCodeSnippet,
  AutocompleteSnippet,
} from "../snippets/types";
import { HelperVars } from "../util/HelperVars";

import { isValidSnippet } from "./validation";

const getRemainingTokenCount = (helper: HelperVars): number => {
  const tokenCount = countTokens(helper.prunedCaretWindow, helper.modelName);

  return helper.options.maxPromptTokens - tokenCount;
};

const TOKEN_BUFFER = 10; // We may need extra tokens for snippet description etc.

/**
 * Shuffles an array in place using the Fisher-Yates algorithm.
 * @param array The array to shuffle.
 * @returns The shuffled array.
 */
const shuffleArray = <T>(array: T[]): T[] => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

function filterSnippetsAlreadyInCaretWindow(
  snippets: AutocompleteCodeSnippet[],
  caretWindow: string,
): AutocompleteCodeSnippet[] {
  return snippets.filter(
    (s) => s.content.trim() !== "" && !caretWindow.includes(s.content.trim()),
  );
}

export const getSnippets = (
  helper: HelperVars,
  payload: SnippetPayload,
): AutocompleteSnippet[] => {
  const snippets = {
    recentlyEditedRanges: payload.recentlyEditedRangeSnippets,
    base: shuffleArray(
      filterSnippetsAlreadyInCaretWindow(
        [...payload.rootPathSnippets, ...payload.importDefinitionSnippets],
        helper.prunedCaretWindow,
      ),
    ),
  };

  // Only allow base and recentlyEditedRanges
  const snippetConfigs: {
    key: keyof typeof snippets;
    enabledOrPriority: boolean | number;
    defaultPriority: number;
    snippets: AutocompleteSnippet[];
  }[] = [
    {
      key: "recentlyEditedRanges",
      enabledOrPriority: helper.options.experimental_includeRecentlyEditedRanges,
      defaultPriority: 1,
      snippets: payload.recentlyEditedRangeSnippets,
    },
    {
      key: "base",
      enabledOrPriority: true,
      defaultPriority: 99, // make sure it's the last one to be processed, but still possible to override
      snippets: shuffleArray(
        filterSnippetsAlreadyInCaretWindow(
          [...payload.rootPathSnippets, ...payload.importDefinitionSnippets],
          helper.prunedCaretWindow,
        ),
      ),
    },
  ];

  // Create a readable order of enabled snippets
  const snippetOrder = snippetConfigs
    .filter(({ enabledOrPriority }) => enabledOrPriority)
    .map(({ key, enabledOrPriority, defaultPriority }) => ({
      key,
      priority:
        typeof enabledOrPriority === "number"
          ? enabledOrPriority
          : defaultPriority,
    }))
    .sort((a, b) => a.priority - b.priority);

  // Log the snippet order for debugging - uncomment if needed
  /* console.log(
    'Snippet processing order:',
    snippetOrder
      .map(({ key, priority }) => `${key} (priority: ${priority})`).join("\n")
  ); */

  // Convert configs to prioritized snippets
  let prioritizedSnippets = snippetOrder
    .flatMap(({ key, priority }) =>
      snippets[key].map((snippet) => ({ snippet, priority })),
    )
    .sort((a, b) => a.priority - b.priority)
    .map(({ snippet }) => snippet);

  // Exclude Continue's own output as it makes it super-hard for users to test the autocomplete feature
  // while looking at the prompts in the Continue's output
  prioritizedSnippets = prioritizedSnippets.filter(
    (snippet) =>
      !(snippet as AutocompleteCodeSnippet).filepath?.startsWith(
        "output:extension-output-Continue.continue",
      ),
  );

  const finalSnippets = [];
  let remainingTokenCount = getRemainingTokenCount(helper);

  while (remainingTokenCount > 0 && prioritizedSnippets.length > 0) {
    const snippet = prioritizedSnippets.shift();
    if (!snippet || !isValidSnippet(snippet)) {
      continue;
    }

    const snippetSize =
      countTokens(snippet.content, helper.modelName) + TOKEN_BUFFER;

    if (remainingTokenCount >= snippetSize) {
      finalSnippets.push(snippet);
      remainingTokenCount -= snippetSize;
    }
  }

  return finalSnippets;
};
