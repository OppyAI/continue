import { CompletionOptions, ILLM } from "../..";
import { StreamTransformPipeline } from "../filtering/streamTransforms/StreamTransformPipeline";
import { HelperVars } from "../util/HelperVars";

import { GeneratorReuseManager } from "./GeneratorReuseManager";

export class CompletionStreamer {
  private streamTransformPipeline = new StreamTransformPipeline();
  private generatorReuseManager: GeneratorReuseManager;

  constructor(onError: (err: any) => void) {
    this.generatorReuseManager = new GeneratorReuseManager(onError);
  }

  async *streamCompletionWithFilters(
    token: AbortSignal,
    llm: ILLM,
    prefix: string,
    suffix: string,
    prompt: string,
    multiline: boolean,
    completionOptions: Partial<CompletionOptions> | undefined,
    helper: HelperVars,
  ) {
    // Full stop means to stop the LLM's generation, instead of just truncating the displayed completion
    const fullStop = () =>
      this.generatorReuseManager.currentGenerator?.cancel();

    // Try to reuse pending requests if what the user typed matches start of completion
    const generator = this.generatorReuseManager.getGenerator(
      prefix,
      (abortSignal: AbortSignal) => {
        const generator = llm.supportsFim()
          ? llm.streamFim(prefix, suffix, abortSignal, completionOptions)
          : llm.streamComplete(prompt, abortSignal, {
              ...completionOptions,
              raw: true,
            });
        // Remove all other stopping logic: always use the transform pipeline
        return generator;
      },
      true,
    );

    // LLM
    const generatorWithCancellation = async function* () {
      for await (const update of generator) {
        if (token.aborted) {
          return;
        }
        yield update;
      }
    };

    const initialGenerator = generatorWithCancellation();
    // Always use the transform pipeline, regardless of helper.options.transform
    const transformedGenerator = this.streamTransformPipeline.transform(
      initialGenerator,
      prefix,
      suffix,
      multiline,
      [], // Ignore stop tokens
      fullStop,
      helper,
    );

    for await (const update of transformedGenerator) {
      yield update;
    }
  }
}
