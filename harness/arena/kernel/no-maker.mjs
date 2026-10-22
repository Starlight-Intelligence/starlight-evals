// The arena only submits external artifacts, so the kernel never runs a maker for it. If this
// runs, the task was created without --artifact, which is a bug: fail loudly.
console.error('arena kernel tasks are external artifacts; no maker should run');
process.exit(1);
