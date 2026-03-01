import { dnspodDescribeDomainList, dnspodDescribeRecordList, dnspodUpsertRecord } from './dnspod.mjs';

export function makeActions({ secretId, secretKey }) {
  return {
    'dnspod.describe_domain_list': async ({ step, evidenceDir }) => {
      const r = await dnspodDescribeDomainList({ secretId, secretKey, offset: step.params?.offset || 0, limit: step.params?.limit || 20 });
      return { status: r.status, json: r.json };
    },
    'dnspod.describe_record_list': async ({ step }) => {
      const domain = step.params?.domain;
      const r = await dnspodDescribeRecordList({ secretId, secretKey, domain, offset: 0, limit: 200 });
      return { status: r.status, json: r.json };
    },
    'dnspod.upsert_record': async ({ step }) => {
      const p = step.params || {};
      const r = await dnspodUpsertRecord({
        secretId,
        secretKey,
        domain: p.domain,
        subDomain: p.subDomain,
        recordType: p.recordType,
        recordLine: p.recordLine || '默认',
        value: p.value,
        ttl: p.ttl || 600,
      });
      return { mode: r.mode, old: r.old, status: r.result.status, json: r.result.json };
    }
  };
}
