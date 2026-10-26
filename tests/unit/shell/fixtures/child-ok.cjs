// A well-behaved "server": says hello and stays alive.
console.log(JSON.stringify({ level: 'info', msg: 'fixture up', pid: process.pid, restartCount: process.env.LIMS_RESTART_COUNT || '0' }));
setInterval(() => {}, 1000);
