import React, { useEffect, useState } from 'react'
import {
  Game,
  QuestDetails,
  QuestDetailsProps,
  QuestDetailsTranslations
} from '@hyperplay/ui'
import styles from './index.module.scss'
import useGetQuest from 'frontend/hooks/useGetQuest'
import useGetSteamGame from 'frontend/hooks/useGetSteamGame'
import useAuthSession from 'frontend/hooks/useAuthSession'
import { useTranslation } from 'react-i18next'
import { http, useAccount, useSwitchChain, useWriteContract } from 'wagmi'
import { ConfirmClaimParams, Reward, RewardClaimSignature } from 'common/types'
import authState from 'frontend/state/authState'
import { mintReward } from './rewards/mintReward'
import { claimPoints } from './rewards/claimPoints'
import {
  completeExternalTask,
  resyncExternalTasks
} from './rewards/completeExternalTask'
import useGetUserPlayStreak from 'frontend/hooks/useGetUserPlayStreak'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useFlags } from 'launchdarkly-react-client-sdk'
import { getPlaystreakArgsFromQuestData } from 'frontend/helpers/getPlaystreakArgsFromQuestData'
import { useGetRewards } from 'frontend/hooks/useGetRewards'
import { createPublicClient } from 'viem'
import { chainMap, parseChainMetadataToViemChain } from '@hyperplay/chains'
import { InfoAlertProps } from '@hyperplay/ui/dist/components/AlertCard'
import { useSyncPlaySession } from 'frontend/hooks/useSyncInterval'
import { useTrackQuestViewed } from 'frontend/hooks/useTrackQuestViewed'
import { ConfirmClaimModal } from './components/ConfirmClaimModal'
import { RewardClaimError } from 'backend/metrics/types'
import { getBalance } from '@wagmi/core'
import { config } from 'frontend/config'

class ClaimError extends Error {
  properties: RewardClaimError['properties']

  constructor(message: string, properties: RewardClaimError['properties']) {
    super(message)
    this.properties = properties
  }
}

export interface QuestDetailsWrapperProps {
  selectedQuestId: number | null
  projectId: string
}

const averageEstimatedGasUsagePerFunction: Record<string, number> = {
  ERC1155: 102_470,
  ERC721: 107_567,
  ERC20: 98_507
}

async function getRewardClaimGasEstimation(reward: Reward) {
  if (!reward.chain_id) {
    throw Error(`chain_id is not set for reward: ${reward.id}`)
  }

  const chainMetadata = chainMap[reward.chain_id]

  if (!chainMetadata) {
    throw Error(`chainMetadata is not set for reward: ${reward.id}`)
  }

  const viemChain = parseChainMetadataToViemChain(chainMetadata)

  const publicClient = createPublicClient({
    chain: viemChain,
    transport: http()
  })

  let gasPerFunction

  switch (reward.reward_type) {
    case 'ERC1155':
    case 'ERC721':
    case 'ERC20':
      // we bump by 50% to account for potential gas price fluctuations
      gasPerFunction = Math.ceil(
        averageEstimatedGasUsagePerFunction[reward.reward_type] * 1.5
      )
      break
    default:
      throw Error(`unknown reward type ${reward.reward_type}`)
  }

  const gasPrice = await publicClient.getGasPrice()
  const gasNeeded = BigInt(gasPerFunction) * gasPrice

  window.api.logInfo(
    `Gas needed to claim ${reward.reward_type} reward: ${gasNeeded} (${gasPerFunction} gas per function * ${gasPrice} gas price)`
  )

  return gasNeeded
}

export function QuestDetailsWrapper({
  selectedQuestId,
  projectId
}: QuestDetailsWrapperProps) {
  const {
    writeContractAsync,
    error: writeContractError,
    isPending: isPendingWriteContract,
    reset: resetWriteContract
  } = useWriteContract()

  const {
    switchChainAsync,
    isPending: isPendingSwitchingChain,
    error: switchChainError
  } = useSwitchChain()

  useTrackQuestViewed(selectedQuestId)

  const flags = useFlags()
  const account = useAccount()
  const [showWarning, setShowWarning] = useState(false)
  const { t } = useTranslation()
  const questResult = useGetQuest(selectedQuestId)
  const [warningMessage, setWarningMessage] = useState<string>()
  const questMeta = questResult.data.data

  const rewardTypeClaimEnabled: Record<Reward['reward_type'], boolean> = {
    ERC20: flags.erc20RewardsClaim,
    ERC721: flags.erc721RewardsClaim,
    ERC1155: flags.erc1155RewardsClaim,
    POINTS: flags.pointsRewardsClaim,
    'EXTERNAL-TASKS': flags.externalTasksRewardsClaim
  }

  const rewardsQuery = useGetRewards(selectedQuestId)
  const questRewards = rewardsQuery.data.data
  const queryClient = useQueryClient()

  const questPlayStreakResult = useGetUserPlayStreak(selectedQuestId)
  const questPlayStreakData = questPlayStreakResult.data.data

  const resyncMutation = useMutation({
    mutationFn: async (rewards: Reward[]) => {
      const result = await resyncExternalTasks(rewards)
      const queryKey = `useGetG7UserCredits`
      queryClient.invalidateQueries({ queryKey: [queryKey] })
      return result
    },
    onSuccess: async () => {
      await questPlayStreakResult.invalidateQuery()
    }
  })

  const completeTaskMutation = useMutation({
    mutationFn: async (reward: Reward) => {
      const result = await completeExternalTask(reward)
      const queryKey = `useGetG7UserCredits`
      queryClient.invalidateQueries({ queryKey: [queryKey] })
      return result
    },
    onSuccess: async () => {
      await questPlayStreakResult.invalidateQuery()
    }
  })

  const claimPointsMutation = useMutation({
    mutationFn: async (reward: Reward) => {
      const result = await claimPoints(reward)
      const queryKey = `getPointsBalancesForProject:${projectId}`
      queryClient.invalidateQueries({ queryKey: [queryKey] })
      return result
    },
    onSuccess: async () => {
      await questPlayStreakResult.invalidateQuery()
    }
  })

  const confirmClaimMutation = useMutation({
    mutationFn: async (params: ConfirmClaimParams) => {
      return window.api.confirmRewardClaim(params)
    },
    retry: 5,
    retryDelay: 1000,
    onSuccess: async () => {
      await questPlayStreakResult.invalidateQuery()
    },
    onError: (error, variables) => {
      window.api.logError(
        `Error confirming reward claim ${
          error.message
        }, variables: ${JSON.stringify({
          ...variables,
          address: account?.address
        })}`
      )
    }
  })

  let questDetails = null

  const getSteamGameResult = useGetSteamGame(
    questMeta?.eligibility?.steam_games ?? []
  )

  const steamGames: Game[] =
    getSteamGameResult?.data?.map((val, index) => ({
      title: val.data?.name ?? index.toString(),
      imageUrl: val.data?.capsule_image ?? '',
      loading: val.isLoading || val.isFetching
    })) ?? []

  useSyncPlaySession(projectId, questPlayStreakResult.invalidateQuery)

  const [collapseIsOpen, setCollapseIsOpen] = useState(false)
  const session = useAuthSession()
  // TODO: uncomment when reputation quest is activated and pass in quest details eligibility
  // const accounts = session.data?.linkedAccounts
  // const steamIsLinked = accounts?.has('steam')

  const userId = session.data?.userId
  const isSignedIn = !!userId

  const hasMetStreak =
    (questPlayStreakData?.current_playstreak_in_days ?? 0) >=
    (questMeta?.eligibility?.play_streak?.required_playstreak_in_days ??
      Infinity)

  const showResyncButton =
    questMeta?.type === 'PLAYSTREAK' &&
    !hasMetStreak &&
    !!questPlayStreakData?.completed_counter &&
    !!questMeta?.rewards?.filter((val) => val.reward_type === 'EXTERNAL-TASKS')
      ?.length

  const i18n: QuestDetailsTranslations = {
    rewards: t('quest.reward', 'Rewards'),
    associatedGames: t('quest.associatedGames', 'Associated games'),
    linkSteamAccount: t(
      'quest.linkAccount',
      'Link your Steam account to check eligibility.'
    ),
    needMoreAchievements: t(
      'quest.needMoreAchievements',
      `You need to have completed {{percent}}% of the achievements in one of these games.`,
      { percent: questMeta?.eligibility?.completion_threshold ?? '??' }
    ),
    claim: t('quest.claimAll', 'Claim all'),
    signIn: t('quest.signIn', 'Sign in'),
    connectSteamAccount: t(
      'quest.connectSteamAccount',
      'Connect Steam account'
    ),
    questType: {
      REPUTATION: t('quest.type.reputation', 'Reputation'),
      PLAYSTREAK: t('quest.type.playstreak', 'Play Streak')
    },
    sync: t('quest.sync', 'Sync'),
    streakProgressI18n: {
      streakProgress: t('quest.playstreak.streakProgress', 'Streak Progress'),
      days: t('quest.playstreak.days', 'days'),
      playToStart: t(
        'quest.playstreak.playToStart',
        'Play this game to start your streak!'
      ),
      playEachDay: t(
        'quest.playstreak.playEachDay',
        `Play each day so your streak won't reset!`
      ),
      streakCompleted: t(
        'quest.playstreak.streakCompleted',
        'Streak completed! Claim your rewards now.'
      ),
      now: t('quest.playstreak.now', 'Now'),
      dayResets: t('quest.playstreak.dayResets', 'Day resets:'),
      progressTowardsStreak: t(
        'quest.playstreak.progressTowardsStreak',
        `progress towards today's streak.`
      )
    }
  }

  const mintOnChainReward = async (reward: Reward) => {
    setWarningMessage(undefined)

    if (questMeta?.id === undefined) {
      throw Error('tried to mint but quest meta id is undefined')
    }

    if (reward.chain_id === null) {
      throw Error('chain id is not set for reward when trying to mint')
    }

    if (account.address === undefined) {
      setWarningMessage('Please connect your wallet to claim rewards.')
      return
    }

    await switchChainAsync({ chainId: reward.chain_id })

    const gasNeeded = await getRewardClaimGasEstimation(reward)
    const walletBalance = await getBalance(config, {
      address: account.address,
      chainId: reward.chain_id
    })
    const hasEnoughBalance = walletBalance.value >= gasNeeded

    window.api.logInfo(`Current wallet gas: ${walletBalance.value}`)

    if (!hasEnoughBalance) {
      window.api.logError(
        `Not enough balance in the connected wallet to cover the gas fee associated with this Quest Reward claim. Current balance: ${walletBalance.value}, gas needed: ${gasNeeded}`
      )
      setWarningMessage(
        t(
          'quest.notEnoughGas',
          'Insufficient wallet balance to claim your reward due to gas fees. Try a different wallet or replenish this one before retrying.'
        )
      )
      return
    }

    let tokenId: number | undefined = undefined

    const isERC1155Reward =
      reward.reward_type === 'ERC1155' && reward.token_ids.length === 1

    if (isERC1155Reward) {
      tokenId = reward.token_ids[0].token_id
    }

    const claimSignature: RewardClaimSignature =
      await window.api.getQuestRewardSignature(
        account.address,
        reward.id,
        tokenId
      )

    // awaiting is fine for now because we're doing a single write contract at a time,
    // but we might want to not block the UI thread when we implement multiple claims
    const hash = await mintReward({
      questId: questMeta.id,
      signature: claimSignature,
      reward,
      writeContractAsync
    })

    await confirmClaimMutation.mutateAsync({
      signature: claimSignature.signature,
      transactionHash: hash
    })
  }

  async function claimRewards(rewards: Reward[]) {
    for (const reward_i of rewards) {
      const isRewardTypeClaimable = rewardTypeClaimEnabled[reward_i.reward_type]
      if (selectedQuestId === null || !isRewardTypeClaimable) {
        continue
      }
      /* eslint-disable @typescript-eslint/no-unused-vars */
      const {
        amount_per_user,
        chain_id,
        marketplace_url,
        decimals,
        ...rewardToTrack_i
      } = reward_i
      /* eslint-enable @typescript-eslint/no-unused-vars */
      const properties = {
        ...rewardToTrack_i,
        quest_id: selectedQuestId.toString()
      }
      window.api.trackEvent({
        event: 'Reward Claim Started',
        properties
      })

      try {
        switch (reward_i.reward_type) {
          case 'ERC1155':
          case 'ERC721':
          case 'ERC20':
            await mintOnChainReward(reward_i)
            break
          case 'POINTS':
            await claimPointsMutation.mutateAsync(reward_i)
            break
          case 'EXTERNAL-TASKS':
            await completeTaskMutation.mutateAsync(reward_i)
            break
          default:
            console.error(`unknown reward type ${reward_i.reward_type}`)
            break
        }
      } catch (err) {
        throw new ClaimError(`${err}`, properties)
      }

      window.api.trackEvent({
        event: 'Reward Claim Success',
        properties
      })
    }
  }

  const claimRewardsMutation = useMutation({
    mutationFn: async (params: Reward[]) => {
      return claimRewards(params)
    },
    onSuccess: async () => {
      await questPlayStreakResult.invalidateQuery()
    },
    onError: (error) => {
      if (error instanceof ClaimError) {
        window.api.trackEvent({
          event: 'Reward Claim Error',
          properties: error.properties
        })
      }
      console.error('Error claiming rewards:', error)
      window.api.logError(`Error claiming rewards: ${error}`)
    }
  })

  function isEligible() {
    if (!questMeta) {
      return false
    }
    const currentStreak = questPlayStreakData?.current_playstreak_in_days
    const requiredStreak =
      questMeta.eligibility?.play_streak?.required_playstreak_in_days
    if (questMeta.type === 'PLAYSTREAK' && currentStreak && requiredStreak) {
      return currentStreak >= requiredStreak
    }

    return false
  }

  const chainTooltips: Record<string, string> = {}
  chainTooltips[t('quest.points', 'Points')] =
    'Points are off-chain fungible rewards that may or may not be redeemable for an on-chain reward in the future. This is up to the particular game developer who is providing this reward.'

  const isClaiming =
    completeTaskMutation.isPending ||
    claimPointsMutation.isPending ||
    claimRewardsMutation.isPending ||
    isPendingWriteContract ||
    isPendingSwitchingChain

  useEffect(() => {
    setWarningMessage(undefined)
    resetWriteContract()
  }, [selectedQuestId])

  if (selectedQuestId !== null && questMeta && questRewards) {
    const isRewardTypeClaimable = Boolean(
      questMeta?.rewards?.some(
        (reward) => rewardTypeClaimEnabled[reward.reward_type]
      )
    )

    const ctaDisabled =
      !flags.questsOverlayClaimCtaEnabled ||
      (!isEligible() && !showResyncButton) ||
      isClaiming ||
      !isRewardTypeClaimable

    let alertProps: InfoAlertProps | undefined

    if (writeContractError || claimRewardsMutation.error || switchChainError) {
      alertProps = {
        showClose: false,
        title: t('quest.claimFailed', 'Claim failed'),
        message: t(
          'quest.claimFailedMessage',
          "Please try once more. If it still doesn't work, create a Discord support ticket."
        ),
        actionText: t('quest.createDiscordTicket', 'Create Discord Ticket'),
        onActionClick: () => window.api.openDiscordLink(),
        variant: 'danger'
      }
    }

    let networkName = ''

    if (questMeta.rewards?.[0].chain_id) {
      networkName = chainMap[questMeta.rewards[0].chain_id]?.chain?.name ?? ''
    }

    const rewardsToClaim = questMeta.rewards ?? []
    const isRewardOnChain = rewardsToClaim.some((reward) =>
      ['ERC1155', 'ERC721', 'ERC20'].includes(reward.reward_type)
    )

    const questDetailsProps: QuestDetailsProps = {
      alertProps,
      questType: questMeta.type,
      title: questMeta.name,
      description: questMeta.description,
      eligibility: {
        reputation: {
          games: steamGames,
          completionPercent: questMeta.eligibility?.completion_threshold ?? 100,
          eligible: false,
          steamAccountLinked: true
        },
        playStreak: getPlaystreakArgsFromQuestData(
          questMeta,
          questPlayStreakData,
          isSignedIn
        )
      },
      rewards: questRewards ?? [],
      i18n,
      onClaimClick: async () => {
        if (isRewardOnChain) {
          setShowWarning(true)
        } else {
          claimRewardsMutation.mutate(rewardsToClaim)
        }
      },
      onSignInClick: () => authState.openSignInModal(),
      onConnectSteamAccountClick: () => window.api.signInWithProvider('steam'),
      collapseIsOpen,
      toggleCollapse: () => setCollapseIsOpen(!collapseIsOpen),
      errorMessage: warningMessage,
      isMinting: isClaiming,
      isSignedIn,
      ctaDisabled,
      showSync: showResyncButton,
      onSyncClick: () => {
        resyncMutation.mutateAsync(questMeta.rewards ?? [])
      },
      isSyncing: resyncMutation.isPending,
      chainTooltips: {}
    }
    questDetails = (
      <>
        <ConfirmClaimModal
          isOpen={showWarning}
          onConfirm={() => {
            setShowWarning(false)
            claimRewardsMutation.mutate(rewardsToClaim)
          }}
          onCancel={() => setShowWarning(false)}
          onClose={() => setShowWarning(false)}
          networkName={networkName}
        />
        <QuestDetails
          {...questDetailsProps}
          className={styles.questDetails}
          key={`questDetailsLoadedId${
            questMeta.id
          }streak${!!questPlayStreakData}isSignedIn${!!isSignedIn}`}
        />
      </>
    )
  } else if (
    questResult?.data.isLoading ||
    questResult?.data.isFetching ||
    rewardsQuery?.data.isLoading
  ) {
    const emptyQuestDetailsProps: QuestDetailsProps = {
      questType: 'PLAYSTREAK',
      title: '',
      description: '',
      eligibility: {
        reputation: {
          games: [],
          completionPercent: 0,
          eligible: false,
          steamAccountLinked: false
        },
        playStreak: {
          currentStreakInDays: 0,
          requiredStreakInDays: 1,
          minimumSessionTimeInSeconds: 100,
          accumulatedPlaytimeTodayInSeconds: 0,
          lastPlaySessionCompletedDateTimeUTC: new Date().toISOString()
        }
      },
      i18n,
      rewards: [],
      onClaimClick: () => console.log('claim clicked for ', questMeta?.name),
      onSignInClick: () => console.log('sign in clicked for ', questMeta?.name),
      onConnectSteamAccountClick: () =>
        console.log('connect steam account clicked for ', questMeta?.name),
      collapseIsOpen,
      toggleCollapse: () => setCollapseIsOpen(!collapseIsOpen),
      isSignedIn
    }
    questDetails = (
      <QuestDetails
        {...emptyQuestDetailsProps}
        className={styles.questDetails}
        ctaDisabled={true}
        key={'questDetailsLoading'}
      />
    )
  }

  return questDetails
}
