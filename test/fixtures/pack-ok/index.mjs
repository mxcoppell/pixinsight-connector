export const apiVersion = 1;
export const name = 'ok';
export const version = '1.0.0';
export const tools = [{
  name: 'fixture_stretch',
  description: 'A fixture tool that exists only to exercise the pack loader in tests.',
  inputSchema: { type: 'object', properties: { view_id: { type: 'string' } }, required: ['view_id'] },
  handler: async (api, input) => ({ text: `stretched ${input.view_id}` }),
}];
