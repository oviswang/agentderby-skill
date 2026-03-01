import { dnspodDescribeDomainList, dnspodDescribeRecordList, dnspodUpsertRecord, dnspodModifyRecord, dnspodDeleteRecord } from './dnspod.mjs';

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

      // Rollback info
      let rollback = null;
      if (r.mode === 'modify' && r.old?.RecordId) {
        rollback = {
          type: 'dnspod.rollback_record',
          params: {
            mode: 'modify',
            domain: p.domain,
            recordId: r.old.RecordId,
            subDomain: r.old.Name,
            recordType: r.old.Type,
            recordLine: r.old.Line,
            value: r.old.Value,
            ttl: r.old.TTL,
          }
        };
      } else if (r.mode === 'create') {
        const rid = r?.result?.json?.Response?.RecordId || r?.result?.json?.Response?.RecordID || null;
        if (rid) {
          rollback = { type: 'dnspod.rollback_record', params: { mode: 'delete', domain: p.domain, recordId: rid } };
        }
      }

      return { mode: r.mode, old: r.old, status: r.result.status, json: r.result.json, rollback };
    },

    'dnspod.rollback_record': async ({ step }) => {
      const p = step.params || {};
      if (p.mode === 'delete') {
        const r = await dnspodDeleteRecord({ secretId, secretKey, domain: p.domain, recordId: p.recordId });
        return { status: r.status, json: r.json };
      }
      const r = await dnspodModifyRecord({
        secretId,
        secretKey,
        domain: p.domain,
        recordId: p.recordId,
        subDomain: p.subDomain,
        recordType: p.recordType,
        recordLine: p.recordLine || '默认',
        value: p.value,
        ttl: p.ttl || 600,
      });
      return { status: r.status, json: r.json };
    }
  };
}
