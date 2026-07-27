const { log, errors } = require('cozy-konnector-libs')
// Node 16 has no global fetch/Headers: cozy-konnector-libs only assigns
// global.fetch, so require node-fetch explicitly and use a plain object for
// the headers.
const fetch = require('node-fetch')

const API_ROOT = 'https://neobank-api.swile.co/api'

class SwileApi {
  constructor(email, token) {
    this.email = email
    this.token = token

    this.headers = {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  }

  makeRequestOptions(method, body = null) {
    return {
      method: method,
      headers: this.headers,
      redirect: 'follow',
      body: body
    }
  }

  async fetch(url, method = 'GET', body = null) {
    log('info', `req on ${url}: ${method} ${body}`)
    const response = await fetch(
      `${API_ROOT}/${url}`,
      this.makeRequestOptions(method, body)
    )
    if (!response.ok) {
      log('error', `${method} ${url} failed with status ${response.status}`)
      throw new Error(
        response.status === 401 ? errors.LOGIN_FAILED : errors.VENDOR_DOWN
      )
    }
    return await response.json()
  }

  async getCards() {
    return (await this.fetch(`v0/wallets`)).wallets.filter(
      w => w.id !== 'null-wallet'
    )
  }

  async getAllOperations() {
    return (await this.fetch(`v3/user/operations?per=999999`)).items.filter(
      op => {
        op.transactions = op.transactions.filter(t => t.type === 'ORIGIN')
        if (op.transactions.length !== 1) {
          log(
            'warn',
            `operation ${op.id} has ${op.transactions.length} transactions`
          )
          return false
        }
        const transaction = op.transactions[0]
        return (
          transaction.status === 'CAPTURED' ||
          transaction.status === 'VALIDATED'
        )
      }
    )
  }
}

async function getSwileData(email, token) {
  const api = new SwileApi(email, token)
  return [await api.getCards(), await api.getAllOperations()]
}

module.exports = {
  getSwileData
}
