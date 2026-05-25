import pino from "pino";

let _logger: pino.Logger | null = null;

export function initLogger(options: {
  level: string;
  pretty: boolean;
}): pino.Logger {
  const transport =
    options.pretty
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
            ignore: "pid,hostname",
          },
        }
      : undefined;

  _logger = pino(
    {
      level: options.level,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport ? pino.transport(transport) : undefined
  );

  return _logger;
}

export function getLogger(): pino.Logger {
  if (!_logger) {
    _logger = pino({ level: "info" });
  }
  return _logger;
}
