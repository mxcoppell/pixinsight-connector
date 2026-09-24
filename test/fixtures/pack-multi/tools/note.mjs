export const tools = [{
  name: 'fixture_note',
  description: 'A fixture tool that returns its input text without touching PixInsight.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  handler: async (_api, input) => ({ text: `note: ${input.text}` }),
}];
