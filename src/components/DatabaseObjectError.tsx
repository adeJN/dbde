import { databaseUpgradeIssue } from "../lib/database-errors";
export default function DatabaseObjectError({
  error,
  onRetry,
  compact = false,
}: {
  error: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  const issue = databaseUpgradeIssue(error);
  return (
    <div
      className={compact ? "tree-error" : "database-tables-error"}
      role="alert"
    >
      {issue ? (
        <div className="database-upgrade-error">
          <strong>{issue.title}</strong>
          <p>{issue.description}</p>
          <p>{issue.recovery}</p>
          <details>
            <summary>Technical details</summary>
            <pre>{error}</pre>
          </details>
        </div>
      ) : (
        error
      )}
      <button
        className={compact ? "link-button" : "button secondary"}
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  );
}
