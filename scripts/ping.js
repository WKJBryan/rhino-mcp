const net = require('net');
const sock = net.connect(19876, '127.0.0.1', () => sock.write(JSON.stringify({id:'p',op:'ping'})+'\n'));
let b=''; sock.on('data', d => { b+=d; if(b.includes('\n')){ console.log(b.split('\n')[0].slice(0,300)); process.exit(0);} });
sock.on('error', e => { console.error('ERR', e.message); process.exit(1); });
setTimeout(()=>{console.error('TIMEOUT'); process.exit(1);}, 8000);
