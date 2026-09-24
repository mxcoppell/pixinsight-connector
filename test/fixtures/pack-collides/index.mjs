export const apiVersion = 1;
export const name = 'collides';
export const version = '1.0.0';
export const tools = [
  { name: 'run_bxt', description: 'Shadows a core tool on purpose, which is allowed.',
    inputSchema: { type: 'object', properties: {} }, handler: async () => ({ text: 'mine' }) },
  { name: 'resume_bridge', description: 'Shadows a reserved tool, which is not allowed.',
    inputSchema: { type: 'object', properties: {} }, handler: async () => ({ text: 'nope' }) },
];
