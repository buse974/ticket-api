import webpush from 'web-push'
import { env } from '../env.js'
import type { PushPayload } from '../types.js'

// Configure web-push if VAPID keys are set
if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  )
}

export async function sendPushNotification(
  subscription: string,
  payload: PushPayload
): Promise<boolean> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn('VAPID keys not configured, skipping push notification')
    return false
  }

  try {
    const parsedSubscription = JSON.parse(subscription)
    await webpush.sendNotification(parsedSubscription, JSON.stringify(payload))
    return true
  } catch (error) {
    console.error('Failed to send push notification:', error)
    return false
  }
}

export function getVapidPublicKey(): string {
  return env.VAPID_PUBLIC_KEY
}
