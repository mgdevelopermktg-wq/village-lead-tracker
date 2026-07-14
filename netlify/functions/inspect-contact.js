export const handler = async (event) => {
  const id = event.queryStringParameters?.id || '8628858';
  const resp = await fetch(`https://api.spark.re/v2/contacts/${id}`, {
    headers: {
      'Authorization': `Token token="${process.env.SPARK_API_KEY}"`,
      'Accept': 'application/json',
    }
  });
  const data = await resp.json();
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(data, null, 2),
  };
};
