require('colors');

function getTimestamp() {
  return new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
}

function log(message, level = 'INFO') {
  const timestamp = getTimestamp();
  switch(level.toUpperCase()) {
    case 'INFO':
      console.log(`[${timestamp}] [INFO] ${message}`.green);
      break;
    case 'ERROR':
      console.error(`[${timestamp}] [ERROR] ${message}`.red);
      break;
    case 'WARN':
      console.warn(`[${timestamp}] [WARN] ${message}`.yellow);
      break;
    default:
      console.log(`[${timestamp}] [${level}] ${message}`.white);
  }
}

module.exports = {
  info: (message) => log(message, 'INFO'),
  error: (message) => log(message, 'ERROR'),
  warn: (message) => log(message, 'WARN'),
  log: log
};
