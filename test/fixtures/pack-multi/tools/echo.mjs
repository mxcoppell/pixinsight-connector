import { quote } from '../lib/pjsr.mjs';

export const tools = [{
  name: 'fixture_console_echo',
  description: 'A fixture tool that writes a message to the PixInsight console and returns the console output.',
  inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  handler: async (api, input) => {
    const r = await api.pjsr(`console.writeln(${quote(input.message)});`);
    return { text: r.outputs.consoleOutput };
  },
}];
