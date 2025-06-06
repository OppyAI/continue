// Simple test for line counting logic
async function* testGenerator() {
  yield "line1\n";
  yield "line2\n";
  yield "line3\n";
  yield "line4\n";
  yield "line5\n";
  yield "line6\n";
  yield "line7\n";
}

async function* streamTransform(generator) {
  let lineCount = 0;
  let buffer = "";
  
  console.log("Starting stream transform...");
  
  for await (const update of generator) {
    console.log(`Received update: "${update}"`);
    buffer += update;
    
    // Process complete lines
    const lines = buffer.split("\n");
    // Keep the last incomplete line in buffer
    buffer = lines.pop() ?? "";
    
    console.log(`Split into lines:`, lines);
    console.log(`Buffer after split: "${buffer}"`);
    
    // Yield complete lines and count them
    for (const line of lines) {
      const lineWithNewline = line + "\n";
      console.log(`Yielding line ${lineCount + 1}: "${lineWithNewline}"`);
      yield lineWithNewline;
      lineCount++;
      
      // Stop after 5 complete lines
      if (lineCount >= 5) {
        console.log(`Reached 5 lines, stopping!`);
        return;
      }
    }
  }
  
  // Yield any remaining buffer content
  if (buffer.length > 0) {
    console.log(`Yielding remaining buffer: "${buffer}"`);
    yield buffer;
  }
}

async function test() {
  const generator = testGenerator();
  const transformed = streamTransform(generator);
  
  let result = "";
  for await (const chunk of transformed) {
    result += chunk;
    console.log(`Result so far: "${result}"`);
  }
  
  console.log(`\nFinal result: "${result}"`);
  console.log(`Number of lines in result: ${result.split('\n').length - 1}`);
}

test().catch(console.error);
