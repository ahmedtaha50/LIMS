// Dies with an uncaught exception shortly after start; Node prints the stack to stderr and exits 1.
setTimeout(() => { throw new Error('boom from fixture'); }, 50);
