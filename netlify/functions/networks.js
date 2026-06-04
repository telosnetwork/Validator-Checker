const { NETWORKS } = require("../../ifchecker-api");

exports.handler = async () => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  },
  body: JSON.stringify(
    Object.values(NETWORKS).map(({ key, label, rpc, chainId }) => ({
      key,
      label,
      rpc,
      chainId
    }))
  )
});
