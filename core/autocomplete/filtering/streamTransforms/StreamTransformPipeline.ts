import { HelperVars } from "../../util/HelperVars";

export class StreamTransformPipeline {
  async *transform(
    generator: AsyncGenerator<string>,
    prefix: string,
    suffix: string,
    multiline: boolean,
    _stopTokens: string[], // Now ignored
    fullStop: () => void,
    helper: HelperVars,
  ): AsyncGenerator<string> {
    let lineCount = 0;
    let buffer = "";
    let stopped = false;

    for await (const update of generator) {
      if (stopped) {
        break;
      }
      
      buffer += update;
      
      // Process complete lines
      const lines = buffer.split("\n");
      // Keep the last incomplete line in buffer
      buffer = lines.pop() ?? "";
      
      // Yield complete lines and count them
      for (const line of lines) {
        if (stopped) {
          break;
        }
        
        const lineWithNewline = line + "\n";
        yield lineWithNewline;
        lineCount++;
        
        // Stop after 5 complete lines
        if (lineCount >= 5) {
          stopped = true;
          fullStop();
          break;
        }
      }
    }
    
    // Don't yield remaining buffer if we stopped due to line limit
    if (!stopped && buffer.length > 0) {
      yield buffer;
    }
  }
}
