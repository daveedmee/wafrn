import { Op, Sequelize } from 'sequelize'
import {
  Emoji,
  FederatedHost,
  Post,
  QuestionPoll,
  QuestionPollAnswer,
  QuestionPollQuestion,
  User,
  sequelize
} from '../../models/index.js'
import { completeEnvironment } from '../backendOptions.js'
import { activityPubObject } from '../../interfaces/fediverse/activityPubObject.js'
import { postPetitionSigned } from './postPetitionSigned.js'
import { logger } from '../logger.js'
import { Queue, QueueEvents } from 'bullmq'
import _ from 'underscore'
import { emojiToAPTag } from './emojiToAPTag.js'
import { wait } from '../wait.js'
import { loadPoll } from './loadPollFromPost.js'
import { getPostThreadRecursive } from './getPostThreadRecursive.js'

const sendPostQueue = new Queue('sendPostToInboxes', {
  connection: completeEnvironment.bullmqConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000
    },
    removeOnFail: true
  }
})

const queueEvents = new QueueEvents('sendPostToInboxes', {
  connection: completeEnvironment.bullmqConnection
})
async function voteInPoll(userId: string, pollId: number) {
  const user = await User.findByPk(userId)
  if (!user) return

  const votesToSend = await QuestionPollQuestion.findAll({
    include: [
      {
        model: QuestionPollAnswer,
        where: {
          userId: userId
        }
      },
      {
        model: QuestionPoll,
        include: [
          {
            model: Post,
            include: [
              {
                model: User,
                as: 'user'
              }
            ]
          }
        ]
      }
    ],
    where: {
      questionPollId: pollId
    }
  })

  for await (const vote of votesToSend) {
    const voteObject = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        `${completeEnvironment.frontendUrl}/contexts/litepub-0.1.jsonld`
      ],
      actor: `${completeEnvironment.frontendUrl}/fediverse/blog/${user.url.toLowerCase()}`,
      id: `${completeEnvironment.frontendUrl}/fediverse/voteActivity/${userId}/${vote.id}`,
      object: {
        attributedTo: `${completeEnvironment.frontendUrl}/fediverse/blog/${user.url.toLowerCase()}`,
        id: `${completeEnvironment.frontendUrl}/fediverse/vote/${userId}/${vote.id}`,
        inReplyTo: vote.questionPoll.post.remotePostId,
        name: vote.questionText,
        to: vote.questionPoll.post.user.remoteId,
        type: `Note`
      },
      to: vote.questionPoll.post.user.remoteId,
      type: 'Create'
    }
    const inboxes = vote.questionPoll.post.user.remoteInbox
    const sendVoteJob = await sendPostQueue.add(
      'sendChunk',
      {
        objectToSend: voteObject,
        petitionBy: user.dataValues,
        inboxList: inboxes
      },
      {
        priority: 2097152,
        delay: 2500
      }
    )
    sendVoteJob.waitUntilFinished(queueEvents).then(async () => {
      await getPostThreadRecursive(user, vote.questionPoll.post.remotePostId, undefined, vote.questionPoll.postId)
    })
  }
}

export { voteInPoll }
