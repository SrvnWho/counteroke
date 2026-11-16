// Plain-JS entry point so process managers (pm2) don't try to guess a TypeScript runner.
// Node >= 22.18 runs the .ts sources directly by stripping the type annotations.
await import('./src/index.ts');
