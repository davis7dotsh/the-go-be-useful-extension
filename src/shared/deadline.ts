type DeadlineResult<T> =
  | { status: 'resolved'; value: T }
  | { status: 'rejected'; error: unknown }
  | { status: 'timeout' };

// The losing promise remains observed, so a late rejection cannot become unhandled.
export function settleWithin<T>(operation: Promise<T>, milliseconds: number) {
  return new Promise<DeadlineResult<T>>(resolve => {
    const timer = setTimeout(() => resolve({ status: 'timeout' }), milliseconds);
    operation.then(value => {
      clearTimeout(timer);
      resolve({ status: 'resolved', value });
    }, error => {
      clearTimeout(timer);
      resolve({ status: 'rejected', error });
    });
  });
}
