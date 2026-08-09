#!/usr/bin/env node

console.error(
  "Direct deployment is disabled. Run the Gated deployment GitHub workflow with a reviewed 40-character commit SHA.",
);
process.exit(1);
