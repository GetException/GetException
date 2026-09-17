export function EventDiagnostics({
  event,
}: {
  event: {
    apiCode: string | null;
    apiReason: string | null;
    httpStatus: number | null;
    browserName: string | null;
    browserMajor: number | null;
  };
}) {
  if (
    !event.apiCode &&
    !event.apiReason &&
    !event.httpStatus &&
    !event.browserName
  ) {
    return null;
  }

  return (
    <dl className="detail-list">
      {event.browserName && (
        <div>
          <dt>Browser</dt>
          <dd>
            {event.browserName} {event.browserMajor}
          </dd>
        </div>
      )}
      {event.apiCode && (
        <div>
          <dt>API code</dt>
          <dd className="mono">{event.apiCode}</dd>
        </div>
      )}
      {event.apiReason && (
        <div>
          <dt>API reason</dt>
          <dd className="mono">{event.apiReason}</dd>
        </div>
      )}
      {event.httpStatus && (
        <div>
          <dt>HTTP status</dt>
          <dd>{event.httpStatus}</dd>
        </div>
      )}
    </dl>
  );
}
