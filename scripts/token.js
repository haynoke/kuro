// Run in your own terminal. Keep the output private and out of Git.
process.stdout.write(require('node:crypto').randomBytes(32).toString('hex') + '\n');
