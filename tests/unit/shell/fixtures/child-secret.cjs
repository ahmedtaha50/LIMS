// Prints credentials the way a careless library might, then stays alive.
console.log('login ok password=hunter2 Authorization: Bearer abc123.def456.ghi789');
console.error(JSON.stringify({ level: 'error', msg: 'bad', body: { password: 'hunter2', passphrase: 'correct horse' } }));
setInterval(() => {}, 1000);
