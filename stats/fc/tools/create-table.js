// stats/fc/tools/create-table.js — 在 OTS 实例里创建统计表（幂等）
// 运行前设置：OTS_ENDPOINT / OTS_INSTANCE / OTS_AK_ID / OTS_AK_SECRET
'use strict'

const TableStore = require('tablestore')

const TABLE = process.env.OTS_TABLE || 'dshl_stats'

function client() {
  const endpoint = process.env.OTS_ENDPOINT
  const instancename = process.env.OTS_INSTANCE
  const accessKeyId = process.env.OTS_AK_ID
  const accessKeySecret = process.env.OTS_AK_SECRET
  if (!endpoint || !instancename || !accessKeyId || !accessKeySecret) {
    throw new Error('缺少 OTS_ENDPOINT / OTS_INSTANCE / OTS_AK_ID / OTS_AK_SECRET')
  }
  return new TableStore.Client({ endpoint, instancename, accessKeyId, accessKeySecret, maxRetries: 3 })
}

function call(fn) {
  return new Promise((resolve, reject) => {
    fn((error, data) => (error ? reject(error) : resolve(data)))
  })
}

async function main() {
  const c = client()
  try {
    await call((cb) => c.describeTable({ tableName: TABLE }, cb))
    console.log(`表已存在：${TABLE}`)
    return
  } catch (error) {
    if (!/not exist|OTSObjectNotExist/i.test(String(error && (error.code || error.message)))) throw error
  }
  await call((cb) => c.createTable({
    tableMeta: {
      tableName: TABLE,
      primaryKey: [{ name: 'pk', type: TableStore.PrimaryKeyType.STRING }],
    },
    reservedThroughput: { capacityUnit: { read: 0, write: 0 } },
    tableOptions: { timeToLive: -1, maxVersions: 1 },
  }, cb))
  console.log(`已创建表：${TABLE}（主键 pk，TTL 永久，最多 1 个版本）`)
}

main().catch((error) => {
  console.error('创建表失败：' + (error && error.message ? error.message : String(error)))
  process.exitCode = 1
})
