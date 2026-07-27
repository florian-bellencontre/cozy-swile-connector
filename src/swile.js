const { log, errors } = require('cozy-konnector-libs')
// Node 16 has no global fetch. Webpack wraps the module so the function is
// exposed on .default, while a plain node require returns it directly.
const nodeFetch = require('node-fetch')
const fetch = nodeFetch.default || nodeFetch

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
    const wallets = (await this.fetch(`v0/wallets`)).wallets.filter(
      w => w.id !== 'null-wallet'
    )
    log('info', `Found ${wallets.length} wallet(s)`)
    return wallets
  }

  // Paginate instead of asking for one huge page: the API silently caps the
  // page size, which would truncate the history without any error.
  async getAllOperations() {
    const perPage = 100
    const maxPages = 200
    const items = []

    for (let page = 1; page <= maxPages; page++) {
      const response = await this.fetch(
        `v3/user/operations?per=${perPage}&page=${page}`
      )
      const pageItems = response.items || []
      items.push(...pageItems)
      if (pageItems.length < perPage) {
        break
      }
      if (page === maxPages) {
        log('warn', `Reached the ${maxPages} pages limit, history may be cut`)
      }
    }

    log('info', `Fetched ${items.length} operations`)

    return items.filter(op => {
      op.transactions = (op.transactions || []).filter(t => t.type === 'ORIGIN')
      if (op.transactions.length !== 1) {
        log(
          'warn',
          `operation ${op.id} has ${op.transactions.length} origin transactions, ignoring it`
        )
        return false
      }
      const transaction = op.transactions[0]
      return (
        transaction.status === 'CAPTURED' || transaction.status === 'VALIDATED'
      )
    })
  }
}

async function getSwileData(email, token) {
  const api = new SwileApi(email, token)
  return [await api.getCards(), await api.getAllOperations()]
}

module.exports = {
  getSwileData
}
