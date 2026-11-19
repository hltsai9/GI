import { config } from '../config.js';
import { MockIssueSource } from './mockSource.js';
import { createOracleSource } from './oracleSource.js';
import type { IssueSource } from './source.js';

let source: IssueSource | undefined;

export async function getIssueSource(): Promise<IssueSource> {
  source ??= config.ISSUE_SOURCE === 'oracle' ? await createOracleSource(config) : MockIssueSource.fromDir();
  return source;
}

export function setIssueSource(s: IssueSource) {
  source = s;
}
