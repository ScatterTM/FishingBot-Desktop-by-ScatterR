// Entry point for the local edition (npm start, Start-Local.bat, or FishingbotServer.exe).
// env.js must be imported first: it loads .env before the rest of the code reads it.
import './env.js';
import { startServer } from './server.js';
import { startAutoBackup } from './auto-backup.js';

const server = startServer();
startAutoBackup();

// The desktop shell redirects stdin and sends this command when the user presses
// Stop or closes the window. Keep Ctrl+C / SIGTERM handling for console users.
if (process.stdin && !process.stdin.isTTY) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    const lines = input.split(/\r?\n/);
    input = lines.pop() || '';
    for (const line of lines) {
      if (line.trim().toLowerCase() === 'shutdown') process.emit('SIGTERM');
    }
  });
}
