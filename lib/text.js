/**
 * Fishing Hub UI copy.
 *
 * Keep user-facing website text here whenever possible. The page renderer
 * exposes this catalog to the browser as `window.FISHING_TEXT`, so text can be
 * updated without digging through the large index.html file.
 */
export const SITE_TEXT = {
  site: {
    title: 'Twitch Fishing Hub • Live Loot & Leaderboards',
  },
  common: {
    close: 'Close',
    no: 'No',
    deleteMyData: 'Delete my data',
    deleting: 'Deleting…',
    yesDeleteMyData: 'Yes, delete my data',
  },
  tutorial: {
    onboarding: {
      firstGoal: 'Your first milestone is 25 catches. Use !fish in chat. This progress updates live while you fish.',
      firstGoalKicker: 'FIRST GOAL',
      firstGoalDismiss: 'Catch 25 fish, then continue here',
      firstGoalProgress: 'CATCH 25 FISH',
      complete: "You've completed the tutorial! Auto-Fish is unlocked. For more info on any feature, check out the Guide (highlighted at the top). Press DONE to claim your reward of 10 random Treasury items and explore freely.",
      completeKicker: 'TUTORIAL COMPLETE',
      completeDismiss: 'Press DONE to finish the tutorial',
    },
    manual: {
      endButton: 'End tutorial',
      resumeButton: 'Resume tutorial',
      modalTitle: 'End tutorial?',
      modalWarning: 'Your current tutorial progress will be saved, but ending the tutorial manually will not award the completion reward. You can resume the tutorial later from the same step.',
      cancel: 'Cancel',
      confirm: 'End tutorial',
      ended: 'Tutorial ended. Your progress was saved without a completion reward.',
      resumed: 'Tutorial resumed from your saved step.',
    },
  },
  dataPrivacy: {
    nav: 'Data & Privacy',
    heading: 'Data & Privacy',
    subtitle: 'Review what Fishing Hub stores for your Twitch account and permanently delete your Fishing Hub game data.',
    intro: 'Deleting your data is permanent and cannot be undone. This removes the Fishing Hub game data associated with your currently logged-in Twitch account. It does not delete your Twitch account.',
    note: 'Your Twitch login itself is not deleted. The deletion action signs you out of Fishing Hub after the Fishing Hub data has been removed.',
    dangerTitle: 'Delete all Fishing Hub data',
    dangerCopy: 'Use this only if you want to permanently erase the Fishing Hub data listed above for this Twitch account.',
    modalTitle: 'Delete my data?',
    modalWarning: 'Are you sure? This permanently deletes your Fishing Hub game data associated with this Twitch account. This cannot be undone.',
    loginRequired: 'Log in with Twitch before deleting your data.',
    deleted: 'Your Fishing Hub data has been deleted.',
    deletionFailed: 'Could not delete your data.',
    items: {
      fishdex: {
        title: 'Fishdex & catch history',
        copy: 'Fish counts, best catches, rare catches, collected catch records and Fishdex-related progress.',
      },
      inventory: {
        title: 'Inventory & shop',
        copy: 'Bait, shields, luck boosts, shop purchases and other Fishing Hub inventory.',
      },
      progression: {
        title: 'Progression',
        copy: 'Catch milestones, treasury progress, unique/rare/legendary/godly progress, areas, rod, titles and cosmetics.',
      },
      systems: {
        title: 'Fishing systems',
        copy: 'Selected area and area settings, Auto-Fish state, Pond state and other account-linked gameplay state.',
      },
      customisation: {
        title: 'Chat customisation',
        copy: 'Saved fishing-message formatting and player-facing chat display preferences.',
      },
      mailTutorial: {
        title: 'Mail & tutorial state',
        copy: 'Fishing Hub mail, mail read state and first-fish tutorial/reset state.',
      },
    },
  },
  footer: {
    privacy: 'Privacy',
    terms: 'Terms',
    contact: 'Contact',
    german: 'Deutsch',
    report: 'Report a problem',
    idea: 'Submit an idea',
  },
};