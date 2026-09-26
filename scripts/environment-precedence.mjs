const STATUS = Object.freeze({ PASS: 'pass', FAIL: 'fail', NOT_VERIFIED: 'not_verified' });

export function evaluateEnvironmentPrecedence({ control, configured, expected }) {
  if (!control || !configured) {
    const missing = [!control && 'control', !configured && 'configured'].filter(Boolean);
    return {
      status: STATUS.NOT_VERIFIED,
      detail: `Missing ${missing.join(' and ')} observation.`,
      candidates: Object.entries(expected).map(([name, expectedValue]) => ({
        name,
        ...(control && Object.hasOwn(control, name) ? { control: control[name] } : {}),
        ...(configured && Object.hasOwn(configured, name) ? { configured: configured[name] } : {}),
        expected: expectedValue,
        status: STATUS.NOT_VERIFIED,
        detail: `The ${missing.join(' and ')} observation was unavailable.`,
      })),
    };
  }
  const candidates = Object.entries(expected).map(([name, expectedValue]) => {
    const controlPresent = Object.hasOwn(control, name);
    const configuredPresent = Object.hasOwn(configured, name);
    const values = {
      name,
      ...(controlPresent ? { control: control[name] } : {}),
      ...(configuredPresent ? { configured: configured[name] } : {}),
      expected: expectedValue,
    };
    if (!configuredPresent || configured[name] !== expectedValue) {
      return { ...values, status: STATUS.FAIL,
        detail: configuredPresent ? 'The configured value was not delivered.' : 'The configured variable was missing.' };
    }
    if (!controlPresent) {
      return { ...values, status: STATUS.NOT_VERIFIED,
        detail: 'The control process had no ambient value, so replacement was not observable.' };
    }
    if (control[name] === expectedValue) {
      return { ...values, status: STATUS.NOT_VERIFIED,
        detail: 'The control value already matched the configured value, so replacement was not observable.' };
    }
    return { ...values, status: STATUS.PASS,
      detail: 'The configured value replaced a different ambient control value.' };
  });
  const failed = candidates.filter(({ status }) => status === STATUS.FAIL).map(({ name }) => name);
  const passed = candidates.filter(({ status }) => status === STATUS.PASS).map(({ name }) => name);
  if (failed.length > 0) {
    return { status: STATUS.FAIL,
      detail: `Configured overrides were not delivered for: ${failed.join(', ')}.`, candidates };
  }
  if (passed.length > 0) {
    return { status: STATUS.PASS,
      detail: `Configured overrides replaced ambient values for: ${passed.join(', ')}.`, candidates };
  }
  return { status: STATUS.NOT_VERIFIED,
    detail: 'No candidate had a different ambient control value to replace.', candidates };
}
