describe('createLogger', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates a logger with the given name prefix', async () => {
    // In test env (not production), default level is "debug", so all levels should log
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    delete process.env.NEXT_PUBLIC_LOG_LEVEL;

    // Re-import to pick up env changes
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const logger = createLogger('TestModule');
    logger.info('hello');

    expect(spy).toHaveBeenCalledWith('[TestModule]', 'hello');
  });

  it('logs debug messages when level is debug', async () => {
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'debug';
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const logger = createLogger('App');
    logger.debug('debug msg');

    expect(spy).toHaveBeenCalledWith('[App]', 'debug msg');
  });

  it('suppresses debug when level is info', async () => {
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'info';
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const logger = createLogger('App');
    logger.debug('should not appear');

    expect(spy).not.toHaveBeenCalled();
  });

  it('logs warn and error when level is warn', async () => {
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'warn';
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const logger = createLogger('App');
    logger.info('no');
    logger.warn('yes');
    logger.error('yes');

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[App]', 'yes');
    expect(errorSpy).toHaveBeenCalledWith('[App]', 'yes');
  });

  it('suppresses all output when level is silent', async () => {
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'silent';
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const logger = createLogger('App');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('passes multiple arguments to console methods', async () => {
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'debug';
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('Err');
    const errObj = new Error('fail');
    logger.error('something failed', errObj, 42);

    expect(spy).toHaveBeenCalledWith('[Err]', 'something failed', errObj, 42);
  });
});

describe('errorThrottled', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs error on first call', async () => {
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'debug';
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('Throttle');
    logger.errorThrottled('something broke');

    expect(errorSpy).toHaveBeenCalledWith('[Throttle]', 'something broke');
  });

  it('throttles duplicate messages within 5s window', async () => {
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'debug';
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const logger = createLogger('Throttle');

    logger.errorThrottled('duplicate msg');
    logger.errorThrottled('duplicate msg');
    logger.errorThrottled('duplicate msg');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(2);
  });

  it('allows logging again after throttle window expires', async () => {
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'debug';
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('Throttle');

    logger.errorThrottled('msg');
    expect(errorSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000);

    logger.errorThrottled('msg');
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('does not throttle different messages', async () => {
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'debug';
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('Throttle');

    logger.errorThrottled('msg A');
    logger.errorThrottled('msg B');

    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});

describe('transientError', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('logs network errors at warn level', async () => {
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'debug';
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('Net');

    const networkErr = new TypeError('Failed to fetch');
    logger.transientError('Request failed', networkErr);

    expect(warnSpy).toHaveBeenCalledWith('[Net]', 'Request failed', networkErr);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs AbortError at warn level', async () => {
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'debug';
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('Net');

    const abortErr = new DOMException('The operation was aborted', 'AbortError');
    logger.transientError('Request aborted', abortErr);

    expect(warnSpy).toHaveBeenCalledWith('[Net]', 'Request aborted', abortErr);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs non-transient errors at error level', async () => {
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'debug';
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('Net');

    const validationErr = new Error('Invalid input');
    logger.transientError('Operation failed', validationErr);

    expect(errorSpy).toHaveBeenCalledWith('[Net]', 'Operation failed', validationErr);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs errors with network-related message at warn level', async () => {
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'debug';
    vi.resetModules();
    const { createLogger } = await import('../logger');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger('Net');

    const connErr = new Error('ECONNREFUSED 127.0.0.1:3001');
    logger.transientError('Connection refused', connErr);

    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('isTransientError', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('identifies TypeError: Failed to fetch as transient', async () => {
    vi.resetModules();
    const { isTransientError } = await import('../logger');

    expect(isTransientError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('identifies AbortError as transient', async () => {
    vi.resetModules();
    const { isTransientError } = await import('../logger');

    expect(isTransientError(new DOMException('The operation was aborted', 'AbortError'))).toBe(
      true,
    );
  });

  it('identifies ECONNREFUSED as transient', async () => {
    vi.resetModules();
    const { isTransientError } = await import('../logger');

    expect(isTransientError(new Error('ECONNREFUSED 127.0.0.1:3001'))).toBe(true);
  });

  it('does not identify validation errors as transient', async () => {
    vi.resetModules();
    const { isTransientError } = await import('../logger');

    expect(isTransientError(new Error('Invalid input'))).toBe(false);
  });

  it('checks error.cause recursively', async () => {
    vi.resetModules();
    const { isTransientError } = await import('../logger');

    const wrappedErr = new Error('Wrapper', {
      cause: new TypeError('Failed to fetch'),
    });
    expect(isTransientError(wrappedErr)).toBe(true);
  });

  it('returns false for non-Error values', async () => {
    vi.resetModules();
    const { isTransientError } = await import('../logger');

    expect(isTransientError('string error')).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

describe('warnThrottled', () => {
  it('logs transient warnings at most once per minute, including at epoch zero', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.resetModules();
    const prior = process.env.NEXT_PUBLIC_LOG_LEVEL;
    process.env.NEXT_PUBLIC_LOG_LEVEL = 'debug';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { createLogger } = await import('../logger');
      const log = createLogger('Timeout');
      log.warnThrottled('timeout', 'GET /tasks/1');
      log.warnThrottled('timeout', 'GET /tasks/2');
      vi.advanceTimersByTime(59_999);
      log.warnThrottled('timeout', 'GET /tasks/1');
      expect(warn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      log.warnThrottled('timeout', 'GET /tasks/1');
      expect(warn).toHaveBeenCalledTimes(2);
      expect(error).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.NEXT_PUBLIC_LOG_LEVEL;
      else process.env.NEXT_PUBLIC_LOG_LEVEL = prior;
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
