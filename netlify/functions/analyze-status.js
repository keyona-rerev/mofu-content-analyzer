// Netlify Function: GET /api/analyze-status?id=JOBID
// Polling endpoint for the analyze-background job. Returns:
//   {status: "pending"}                — job hasn't written a result yet
//   {status: "done", ...fullReport}    — finished, report attached
//   {status: "error", error: "..."}    — finished with an error
// The front end polls this every ~2s after kicking off a background job.

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const jobId = String((event.queryStringParameters || {}).id || '').trim();
  if (!jobId) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing job id.' }) };
  }

  const store = getStore('mofu-analyzer-jobs');
  let record;
  try {
    record = await store.get(jobId, { type: 'json' });
  } catch {
    record = null;
  }

  if (!record) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'pending' }) };
  }

  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) };
};
