/*
  This library provides functions for dealing with SLP tokens.
*/

// External npm dependencies.
const BCHJS = require('@abcpros/bch-js')
const bchDonation = require('bch-donation')

// Local dependencies
const SendBCH = require('./send-bch')
const Utxos = require('./utxos')

let _this

// Send the Permissionless Software Foundation a donation to thank them for creating
// and maintaining this software.
const PSF_DONATION = 2000

class Tokens {
  constructor (config) {
    // Encapsulate dependencies.
    this.bchjs = new BCHJS(config)
    this.sendBch = new SendBCH(config)
    this.utxos = new Utxos(config)

    // This should be the last command in the constructor.
    // _this is a local global variable for when 'this' loses scope.
    _this = this
  }

  // This is a wrapper for listTokensFromUtxos(). It takes a BCH address,
  // retrieves the UTXOs for that address and feeds it to listTokensFromUtxos().
  // It returns the results.
  async listTokensFromAddress (addr) {
    try {
      if (!addr) throw new Error('Address not provided')

      // Convert to a BCH address.
      addr = this.bchjs.SLP.Address.toCashAddress(addr)

      // Refresh the utxo store.
      await this.utxos.initUtxoStore(addr)

      const hydratedUtxos = this.utxos.getSpendableTokenUtxos()
      // console.log(`hydratedUtxos: ${JSON.stringify(hydratedUtxos, null, 2)}`)

      return this.listTokensFromUtxos(hydratedUtxos)
    } catch (err) {
      console.error('Error in tokens.js/listTokensFromAddress()')
      throw err
    }
  }

  // Returns an array of Objects with token information. Expects an array of
  // hydrated UTXOs as input.
  listTokensFromUtxos (utxos) {
    try {
      // console.log(`listTokensFromUtxos utxos: ${JSON.stringify(utxos, null, 2)}`)

      // Array used to assemble token information.
      const tokenInfo = []

      utxos.forEach(utxo => {
        // Skip if this is not a valid token UTXO.
        // if (!utxo.isValid) return
        if (!utxo.isValid || utxo.utxoType !== 'token') return

        // Check if the current UTXO represents a token that is already in the
        // tokenInfo array.
        const exists = tokenInfo.findIndex(
          thisToken => thisToken.tokenId === utxo.tokenId
        )
        // console.log(`exists: ${JSON.stringify(exists, null, 2)}`)

        // Token does not exist yet in the list.
        if (exists < 0) {
          const infoObj = {
            tokenId: utxo.tokenId,
            ticker: utxo.tokenTicker,
            name: utxo.tokenName,
            decimals: utxo.decimals,
            tokenType: utxo.tokenType,
            url: utxo.tokenDocumentUrl,
            qty: Number(utxo.tokenQty)
          }

          tokenInfo.push(infoObj)
        } else {
          // Token already exists in the tokenInfo array.
          // Just update the quantity.
          tokenInfo[exists].qty += Number(utxo.tokenQty)
        }
      })

      return tokenInfo
    } catch (err) {
      console.error('Error in tokens.js/listTokensFromUtxos()')
      throw err
    }
  }

  // Top-level wrapper function that orchestrates the sending of tokens.
  // output is a single object that looks like this:
  // {
  //     address: "simpleledger:qqwsylce7r5ufe4mfc94xkd56t30ncnanqahwq6kvv",
  //     tokenId: "497291b8a1dfe69c8daea50677a3d31a5ef0e9484d8bebb610dac64bbc202fb7",
  //     qty: 1
  // }
  async sendTokens (
    output,
    walletInfo,
    bchUtxos,
    tokenUtxos,
    satsPerByte = 1.0
  ) {
    try {
      // Generate the transaction.
      const transaction = await this.createTransaction(
        output,
        walletInfo,
        bchUtxos,
        tokenUtxos,
        satsPerByte
      )

      // Debugging.
      // console.log('transaction hex: ', transaction.hex)

      // Broadcast the transaction to the network.
      const txid = await _this.bchjs.RawTransactions.sendRawTransaction(
        transaction.hex
      )
      // console.log(txid)

      // TODO: Remove the spent UTXOs from the utxoStore.

      return txid
    } catch (err) {
      console.error('Error in tokens.js/sendTokens()')
      throw err
    }
  }

  // Build the transaction for sending a token.
  async createTransaction (
    output,
    walletInfo,
    bchUtxos,
    tokenUtxos,
    satsPerByte = 1.0
  ) {
    try {
      // If the BCH utxos array is still empty, then throw an error.
      if (!bchUtxos || bchUtxos.length === 0) {
        throw new Error('BCH UTXO list is empty')
      }

      // If the BCH utxos array is still empty, then throw an error.
      if (!tokenUtxos || tokenUtxos.length === 0) {
        throw new Error('Token UTXO list is empty')
      }

      // Collect just the UTXOs that match the user-selected token ID.
      const tokenId = output.tokenId

      // Filter out the token UTXOs that match the selected token ID.
      // tokenUtxos = tokenUtxos.filter(e => e.tokenId === tokenId)
      tokenUtxos = tokenUtxos.filter(
        e => e.tokenId === tokenId && e.utxoType === 'token'
      )
      // console.log(`tokenUtxos: ${JSON.stringify(tokenUtxos, null, 2)}`)
      // console.log(`tokenUtxos[0].tokenType: ${tokenUtxos[0].tokenType}`)

      // Generate the BCH output object.
      const bchOutput = [
        {
          address: walletInfo.cashAddress,

          // Premium paid for SLP OP_RETURN data.
          // ToDo: Add a better way to calculate extra costs of OP_RETURN.
          // amountSat: 500
          amountSat: 500 + 50 * satsPerByte
        }
      ]

      // Determine the UTXOs needed to be spent for this TX, and the change
      // that will be returned to the wallet.
      const {
        necessaryUtxos,
        change
      } = _this.sendBch.getNecessaryUtxosAndChange(
        bchOutput,
        bchUtxos,
        satsPerByte
      )

      // Create an instance of the Transaction Builder.
      const transactionBuilder = new _this.bchjs.TransactionBuilder()

      // Add token inputs
      tokenUtxos.forEach(utxo => {
        transactionBuilder.addInput(utxo.tx_hash, utxo.tx_pos)
      })

      // Add BCH inputs
      necessaryUtxos.forEach(utxo => {
        transactionBuilder.addInput(utxo.tx_hash, utxo.tx_pos)
      })

      // Generate the proper SLP OP_RETURN
      let slpSendObj = {}
      // Fungable SLP token.
      if (tokenUtxos[0].tokenType === 1) {
        slpSendObj = await _this.bchjs.SLP.TokenType1.generateSendOpReturn(
          tokenUtxos,
          output.qty
        )

        // NFT (Child)
      } else if (tokenUtxos[0].tokenType === 65) {
        slpSendObj = await _this.bchjs.SLP.NFT1.generateNFTChildSendOpReturn(
          tokenUtxos,
          output.qty
        )

        // NFT Group
      } else if (tokenUtxos[0].tokenType === 129) {
        slpSendObj = await _this.bchjs.SLP.NFT1.generateNFTGroupSendOpReturn(
          tokenUtxos,
          output.qty
        )

        // throw an error for any other token type.
      } else throw new Error(`Token Type ${tokenUtxos[0].tokenType} unknown`)

      const slpBuf = Buffer.from(slpSendObj.script, 'hex')
      transactionBuilder.addOutput(slpBuf, 0)

      // Send dust transaction representing tokens being sent.
      transactionBuilder.addOutput(
        _this.bchjs.SLP.Address.toLegacyAddress(output.address),
        546
      )

      // Return any token change back to the sender.
      if (slpSendObj.outputs > 1) {
        transactionBuilder.addOutput(
          _this.bchjs.SLP.Address.toLegacyAddress(walletInfo.address),
          546
        )
      }

      // Add outputs
      // outputs.forEach(receiver => {
      //   transactionBuilder.addOutput(receiver.address, receiver.amountSat)
      // })
      // transactionBuilder.addOutput(output.address, output.amountSat)

      // Send a 2000 sat donation to PSF to thank them for creating this awesome software.
      // console.log(`psf: ${bchDonation('psf').donations}`)
      transactionBuilder.addOutput(bchDonation('psf').donations, PSF_DONATION)

      // Send change back to the wallet, if it's bigger than dust.
      // console.log(`change: ${change}`)
      if (change && change > 546) {
        transactionBuilder.addOutput(walletInfo.cashAddress, change)
      }

      // Generate a key pair from the mnemonic.
      const keyPair = await _this.sendBch.getKeyPairFromMnemonic(walletInfo)

      // Sign each UTXO that is about to be spent.
      tokenUtxos.forEach((utxo, i) => {
        let redeemScript

        transactionBuilder.sign(
          i,
          keyPair,
          redeemScript,
          transactionBuilder.hashTypes.SIGHASH_ALL,
          utxo.value
        )
      })

      // Sign each UTXO that is about to be spent.
      necessaryUtxos.forEach((utxo, i) => {
        let redeemScript

        transactionBuilder.sign(
          tokenUtxos.length + i,
          keyPair,
          redeemScript,
          transactionBuilder.hashTypes.SIGHASH_ALL,
          utxo.value
        )
      })

      // Build the transaction, return the compiled transaction in hex format.
      const tx = transactionBuilder.build()
      return { hex: tx.toHex(), txid: tx.getId() }
    } catch (err) {
      console.error('Error in tokens.js/createTransaction()')
      throw err
    }
  }

  // Build the transaction to burn tokens.
  async createBurnTransaction (
    qty,
    tokenId,
    walletInfo,
    bchUtxos,
    tokenUtxos,
    satsPerByte = 1.0
  ) {
    try {
      if (!qty || typeof qty !== 'number') {
        throw new Error('qty must be number')
      }
      if (!tokenId || typeof tokenId !== 'string') {
        throw new Error('tokenId must be string')
      }
      if (!walletInfo || typeof walletInfo !== 'object') {
        throw new Error('walletInfo must be a object')
      }
      // If the BCH utxos array is still empty, then throw an error.
      if (!bchUtxos || bchUtxos.length === 0) {
        throw new Error('BCH UTXO list is empty')
      }
      // If the BCH utxos array is still empty, then throw an error.
      if (!tokenUtxos || tokenUtxos.length === 0) {
        throw new Error('Token UTXO list is empty')
      }

      // Filter out the token UTXOs that match the selected token ID.
      // tokenUtxos = tokenUtxos.filter(e => e.tokenId === tokenId)
      tokenUtxos = tokenUtxos.filter(
        e => e.tokenId === tokenId && e.utxoType === 'token'
      )
      if (!tokenUtxos.length) {
        throw new Error('tokenId does not match')
      }
      // console.log(`tokenUtxos: ${JSON.stringify(tokenUtxos, null, 2)}`)
      // console.log(`tokenUtxos[0].tokenType: ${tokenUtxos[0].tokenType}`)

      // Generate the BCH output object.
      const bchOutput = [
        {
          address: walletInfo.cashAddress,

          // Premium paid for SLP OP_RETURN data.
          // ToDo: Add a better way to calculate extra costs of OP_RETURN.
          // amountSat: 500
          amountSat: 500 + 50 * satsPerByte
        }
      ]

      // Determine the UTXOs needed to be spent for this TX, and the change
      // that will be returned to the wallet.
      const {
        necessaryUtxos,
        change
      } = _this.sendBch.getNecessaryUtxosAndChange(
        bchOutput,
        bchUtxos,
        satsPerByte
      )

      // Create an instance of the Transaction Builder.
      const transactionBuilder = new _this.bchjs.TransactionBuilder()

      // Add token inputs
      tokenUtxos.forEach(utxo => {
        transactionBuilder.addInput(utxo.tx_hash, utxo.tx_pos)
      })

      // Add BCH inputs
      necessaryUtxos.forEach(utxo => {
        transactionBuilder.addInput(utxo.tx_hash, utxo.tx_pos)
      })

      if (tokenUtxos[0].tokenType !== 1) {
        throw new Error('Token must be type 1')
      }

      // Generate the proper SLP OP_RETURN
      const slpSendObj = await _this.bchjs.SLP.TokenType1.generateBurnOpReturn(
        tokenUtxos,
        qty
      )

      const slpBuf = slpSendObj // Buffer.from(slpSendObj.script, 'hex')
      transactionBuilder.addOutput(slpBuf, 0)

      // Send dust transaction representing tokens being sent.
      transactionBuilder.addOutput(
        _this.bchjs.SLP.Address.toLegacyAddress(walletInfo.address),
        546
      )

      // Send a 2000 sat donation to PSF to thank them for creating this awesome software.
      // console.log(`psf: ${bchDonation('psf').donations}`)
      transactionBuilder.addOutput(bchDonation('psf').donations, PSF_DONATION)

      // Send change back to the wallet, if it's bigger than dust.
      // console.log(`change: ${change}`)
      if (change && change > 546) {
        transactionBuilder.addOutput(walletInfo.cashAddress, change)
      }

      // Generate a key pair from the mnemonic.
      const keyPair = await _this.sendBch.getKeyPairFromMnemonic(walletInfo)

      // Sign each UTXO that is about to be spent.
      tokenUtxos.forEach((utxo, i) => {
        let redeemScript

        transactionBuilder.sign(
          i,
          keyPair,
          redeemScript,
          transactionBuilder.hashTypes.SIGHASH_ALL,
          utxo.value
        )
      })

      // Sign each UTXO that is about to be spent.
      necessaryUtxos.forEach((utxo, i) => {
        let redeemScript

        transactionBuilder.sign(
          tokenUtxos.length + i,
          keyPair,
          redeemScript,
          transactionBuilder.hashTypes.SIGHASH_ALL,
          utxo.value
        )
      })

      // Build the transaction, return the compiled transaction in hex format.
      const tx = transactionBuilder.build()
      return { hex: tx.toHex(), txid: tx.getId() }
    } catch (err) {
      console.error('Error in tokens.js/createBurnTransaction()')
      throw err
    }
  }

  // Burn a *specific quantity* of tokens.
  async burnTokens (
    qty,
    tokenId,
    walletInfo,
    bchUtxos,
    tokenUtxos,
    satsPerByte = 1.0
  ) {
    try {
      // Generate the transaction.
      const transaction = await this.createBurnTransaction(
        qty,
        tokenId,
        walletInfo,
        bchUtxos,
        tokenUtxos,
        satsPerByte
      )

      // Debugging.
      // console.log('transaction hex: ', transaction.hex)

      // Broadcast the transaction to the network.
      const txid = await _this.bchjs.RawTransactions.sendRawTransaction(
        transaction.hex
      )

      // TODO: Remove the spent UTXOs from the utxoStore.

      return txid
    } catch (err) {
      console.error('Error in tokens.js/burnTokens()')
      throw err
    }
  }

  // Burn ALL the SLP tokens in the wallet associated to the tokenID
  async burnAll (tokenId, walletInfo, bchUtxos, tokenUtxos) {
    try {
      // If the SLP utxos array is still empty, then throw an error.
      if (!tokenId || typeof tokenId !== 'string') {
        throw new Error('tokenId must be a string')
      }
      // If the SLP utxos array is still empty, then throw an error.
      if (!walletInfo || typeof walletInfo !== 'object') {
        throw new Error('walletInfo is required')
      }

      // If the SLP utxos array is still empty, then throw an error.
      if (!bchUtxos || bchUtxos.length === 0) {
        throw new Error('BCH UTXO list is empty')
      }

      // If the BCH utxos array is still empty, then throw an error.
      if (!tokenUtxos || tokenUtxos.length === 0) {
        throw new Error('SLP UTXO list is empty')
      }

      // Get the SLP UTXOs of the tokens to be burned
      tokenUtxos = tokenUtxos.filter(
        e => e.tokenId === tokenId && e.utxoType === 'token'
      )
      // console.log(`tokenUtxos: ${JSON.stringify(tokenUtxos, null, 2)}`)

      // UTXOs array that contains the SLP UTXOs to burn
      // and the necessary BCH UTXOs to pay the fee
      const utxos = tokenUtxos.concat(bchUtxos)
      // console.log(`combined utxos: ${JSON.stringify(utxos, null, 2)}`)

      const txid = await _this.sendBch.sendAllBch(
        walletInfo.cashAddress,
        walletInfo,
        utxos
      )

      // TODO: Remove the spent UTXOs from the utxoStore.

      return txid
    } catch (err) {
      console.error('Error in tokens.js/burnAll()')
      throw err
    }
  }
}

module.exports = Tokens
