import { Logger } from '../utils/logger.mjs'

import chalk from 'chalk'
import { SolanaRepository } from './repository.mjs'
import { SolanaRpc } from './rpc.mjs'
import { Telegram } from '../telegram/index.mjs'
import { absBigInt } from './helpers/bigint.mjs'
import { getAnotherTokenFromSwap, getTokensFromSwaps } from './helpers/token.mjs'
import { swapTemplate } from './messages/swap.mjs'

const logger = new Logger('solana');

export class Solana {
    processing = false;
    interval = null;
    loopDelay = 10000;

    async initialize (app) {
        this.rpc = await app.inject(SolanaRpc);
        this.repository = await app.inject(SolanaRepository);
        this.telegram = await app.inject(Telegram);
    }

    async watch () {
        this.interval = setInterval(async () => {
            if (this.processing) return;
            try {
                this.processing = true;
                await this.loop();
            } finally {
                this.processing = false;
            }
        }, this.loopDelay);
    }

    async loop() {
        const txs = await this.findNewSignatures('GEaqTiqvU5xwbVjVmrG7BEzztCAkHRr8bWeZo9tZWQ2Z');
    }

    async addAccountToWatch (accountAddress, chatId = null) {
        const signatures = await this.rpc.getFinalizedSignaturesForAddress(accountAddress, { limit: 1 });
        const lastSignature = signatures[0].signature;
        await this.repository.addAccountToWatch(accountAddress, lastSignature);
    }

    async findNewSignatures(accountAddress) {
        logger.log('Find new tx`s by account', accountAddress);
        const accountTxsInfo = await this.repository.getAccountTxsInfo(accountAddress);
        const signatures = await this.rpc.getFinalizedSignaturesForAddress(accountAddress, { limit: 1000, until: accountTxsInfo.signature_from });
        for (const { signature } of signatures.reverse()) {
            const tx = await this.addTx(signature);
            await this.repository.setAccountSwapInfo(accountAddress, { signature_from: signature });
            if (tx.swap) {
                const tokenSwap = getAnotherTokenFromSwap(tx.swap);
                await this.swapNotification(accountAddress, tokenSwap);
            }
        }
        return signatures;
    }

    async swapNotification (accountAddress, tokenSwap) {
        const swaps = await this.getAccountTokenSwaps(accountAddress, tokenSwap);
        const message = await swapTemplate(accountAddress, tokenSwap, swaps);

        const con = await this.telegram.client.getConnection();
        // con.sendMessage(5008441322, {
        con.sendMessage(-1002376488914, {
            message,
            parseMode: 'html'
        })
    }

    async indexAccountTxs(walletAddress) {
        logger.log('start index account', walletAddress)

        while (true) {
            const { signature_to } = await this.repository.getAccountTxsInfo(walletAddress);
            logger.log('accountSwapInfo', { signature_to });

            const signatures = await this.rpc.getFinalizedSignaturesForAddress(walletAddress, {
                limit: 1000,
                before: signature_to
            });

            if (!signatures.length) {
                logger.log('finish index', walletAddress);
                break;
            }

            for (const index in signatures) {
                console.log('index', index, typeof index);
                const { signature} = signatures[index];

                logger.log(`request ${ signature } | ${ Number(index) + 1 } of ${ signatures.length }`);

                await this.addTx(signature);
                await this.repository.setAccountSwapInfo(walletAddress, { signature_to: signature });
            }
        }
    }

    async addTx(signature) {
        const transaction = await this.rpc.getParsedTransaction(signature);
        const signer = transaction.transaction.message.accountKeys.find(({signer}) => signer).pubkey;

        const swapInfo = getSwapInfo(transaction);
        if (swapInfo) {
            logger.log(
                'add swap:',
                `${ chalk.green(`+${ swapInfo.tokenIn.amount } ${ swapInfo.tokenIn.mint }`) }`,
                `${ chalk.red(`-${ swapInfo.tokenOut.amount } ${ swapInfo.tokenOut.mint }`) }`
            );

            await this.repository.setAccountTokenSwap(signature, {
                account: signer.toString(),
                token_out: swapInfo.tokenOut.mint,
                token_in: swapInfo.tokenIn.mint,
                amount_out: swapInfo.tokenOut.amount,
                amount_in: swapInfo.tokenIn.amount,
                block_time: transaction.blockTime
            });
        }

        return {
            signature,
            signer: signer.toString(),
            transaction,
            swap: swapInfo
        }
    }

    async getAccountTokenSwaps(walletAddress, tokenAddress) {
        const swaps = await this.repository.getAccountTokenSwaps(walletAddress, tokenAddress);
        const tokensAddress = getTokensFromSwaps(swaps);
        const tokens = await this.getTokensMetadata(tokensAddress);
        return { swaps, tokens }
    }

    async getTokensMetadata(addresses) {
        const tokensMetadata = await this.repository.getTokensMetadata(addresses);
        const tokens = tokensMetadata.reduce((r, i) => { r[i.address] = i; return r;}, {});
        const fetchedTokenAddresses = new Set(Object.keys(tokens));
        const tokensForFetch = addresses.filter(tokenAddress => !fetchedTokenAddresses.has(tokenAddress));

        for (const tokenAddress of tokensForFetch) {
            const tokenMetadata = await this.rpc.getTokensMetadata(tokenAddress);
            await this.repository.setTokenMetadata(tokenAddress, tokenMetadata);
            tokens[tokenAddress] = tokenMetadata;
        }

        return tokens;
    }

}

export function getSwapInfo(transaction, {debug = false} = {debug: false}) {
    const signer = transaction.transaction.message.accountKeys.find(({signer}) => signer).pubkey
    const preBalances = transaction.meta.preTokenBalances || []
    const postBalances = transaction.meta.postTokenBalances || []
    const balancesMap = {}
    const signerBalances = []
    const otherSideBalances = []
    let tokenIn = {}
    let tokenOut = {}

    for (const balance of preBalances) {
        balancesMap[balance.accountIndex] = {
            mint: balance.mint,
            owner: balance.owner,
            preAmount: BigInt(balance.uiTokenAmount.amount || '0'),
            postAmount: BigInt(0)
        }
    }

    for (const balance of postBalances) {
        if (balancesMap[balance.accountIndex]) {
            balancesMap[balance.accountIndex].postAmount = BigInt(balance.uiTokenAmount.amount || '0')
        } else {
            balancesMap[balance.accountIndex] = {
                mint: balance.mint,
                owner: balance.owner,
                preAmount: BigInt(0),
                postAmount: BigInt(balance.uiTokenAmount.amount || '0')
            }
        }
    }

    for (const accountIndex in balancesMap) {
        const balance = balancesMap[accountIndex]
        balance.change = balance.postAmount - balance.preAmount
        balance.signer = balance.owner.toString() === signer.toString()

        if (balance.owner.toString() === signer.toString()) {
            signerBalances.push(balance)
        } else {
            otherSideBalances.push(balance)
        }
    }

    const signerChangesByToken = signerBalances.reduce((result, balance) => {
        result[balance.mint] = (result[balance.mint] || 0n) + balance.change
        return result
    }, {})
    const otherSideChangesByToken = otherSideBalances.reduce((result, balance) => {
        result[balance.mint] = (result[balance.mint] || 0n) + balance.change
        return result
    }, {})

    const signerSwapTokens = Object.keys(signerChangesByToken)
    const otherSideSwapTokens = Object.keys(otherSideChangesByToken).filter(mint => otherSideChangesByToken[mint] !== 0n)

    if (debug) {
        logger.debug('signerChangesByToken', signerChangesByToken)
        logger.debug('otherSideChangesByToken', otherSideChangesByToken)
    }

    if (signerSwapTokens.length === 1 && otherSideSwapTokens.length === 2) {
        const swapTokenMint = signerSwapTokens[0]
        const signerSwapToken = {
            mint: signerSwapTokens[0],
            amount: signerChangesByToken[signerSwapTokens[0]].toString()
        }
        const otherSideSwapTokenMint = otherSideSwapTokens.filter((mint) => mint !== signerSwapToken.mint)[0]
        const otherSideSwapToken = {
            mint: otherSideSwapTokenMint,
            amount: otherSideChangesByToken[otherSideSwapTokenMint].toString()
        }

        if (signerChangesByToken[swapTokenMint] > 0n) {
            tokenIn = signerSwapToken
            tokenOut = otherSideSwapToken
        } else {
            tokenIn = otherSideSwapToken
            tokenOut = signerSwapToken
        }

        return {
            tokenIn: {
                mint: tokenIn.mint,
                amount: absBigInt(tokenIn.amount).toString()
            },
            tokenOut: {
                mint: tokenOut.mint,
                amount: absBigInt(tokenOut.amount).toString()
            }
        }
    }

    return null;
}


// export async function monitorTokens(walletAddress) {
//     const publicKey = new PublicKey(walletAddress)
//
//     const tokenAccounts = await connection.getTokenAccountsByOwner(publicKey, {
//         programId: TOKEN_PROGRAM_ID
//     })
//
//     for (const {account, pubkey} of tokenAccounts.value) {
//         try {
//             const decodedData = AccountLayout.decode(account.data)
//
//             if (decodedData.amount.toString() === '0') continue
//             const mint = new PublicKey(decodedData.mint).toString()
//             // const amount = u64.fromBuffer(decodedData.amount).toString();
//             const metadata = await getTokenMetadata(decodedData.mint)
//
//             console.log(`Token Account: ${ pubkey.toString() }`)
//             console.log(`Mint: ${ mint }`)
//             console.log(`Metadata`, metadata)
//             console.log(`Balance: ${ decodedData.amount.toString() }`)
//             console.log(`========`)
//         } catch (error) {
//             console.error('Error decoding account data:', error)
//         }
//     }
// }

// export async function getSignatures(accountAddress) {
//     const publicKey = new PublicKey(accountAddress)
//
//     try {
//         const signatures = await connection.getSignaturesForAddress(publicKey, {limit: 2}, 'finalized')
//         console.log('signatures', signatures)
//         for (const signature of signatures) {
//             await getBalanceChangesBySignature(signature, mintAddress)
//         }
//     } catch (error) {
//         console.error('Error:', error)
//     }
// }
