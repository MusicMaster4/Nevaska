import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node scripts/check-engine.mjs <engine executable>');
const child = spawn(executable, [], { cwd: dirname(executable), windowsHide: true });
const send = (line) => child.stdin.write(line + '\n');
let name = '', bestmove = '', lastInfo = '', searching = false;
const timer = setTimeout(() => { child.kill(); console.error('Engine timed out'); process.exitCode = 1; }, 60000);
child.stderr.on('data', (data) => process.stderr.write(data));
child.on('error', (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
createInterface({ input: child.stdout }).on('line', (line) => {
  if (line.startsWith('id name ')) name = line.slice(8);
  if (line === 'uciok') {
    send('setoption name Threads value 4');
    send('setoption name MultiPV value 3');
    send('setoption name UCI_ShowWDL value true');
    send('isready');
  }
  if (line === 'readyok' && !searching) {
    searching = true;
    send('position startpos moves e2e4');
    send('go movetime 3000');
  }
  if (line.startsWith('info ') && line.includes(' pv ')) lastInfo = line;
  if (line.startsWith('bestmove ')) { bestmove = line.split(' ')[1]; send('quit'); }
});
child.on('close', (code) => {
  clearTimeout(timer);
  const passed = code === 0 && Boolean(name && bestmove && lastInfo) && bestmove !== '0000';
  console.log(JSON.stringify({ passed, name, bestmove, lastInfo, exitCode: code }, null, 2));
  if (!passed) process.exitCode = 1;
});
send('uci');
