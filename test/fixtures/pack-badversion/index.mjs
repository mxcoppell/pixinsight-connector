export const apiVersion = 99;
export const name = 'from-the-future';
export const version = '1.0.0';
export const tools = [{ name: 'fixture_future', description: 'Never loaded.',
  inputSchema: { type: 'object', properties: {} }, handler: async () => ({ text: '' }) }];
