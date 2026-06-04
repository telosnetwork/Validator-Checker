const { evaluateReadiness } = require("../../ifchecker-api");

exports.handler = async (event) => {
  const network = event.queryStringParameters?.network || event.path.split("/").pop();

  try {
    const payload = await evaluateReadiness(network);
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      },
      body: JSON.stringify(payload)
    };
  } catch (error) {
    return {
      statusCode: error.status || 500,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      },
      body: JSON.stringify({
        error: error.message,
        status: error.status || 500
      })
    };
  }
};
