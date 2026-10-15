import { schedule, ScheduledTask, validate } from 'node-cron';
import cronstrue from 'cronstrue';
import CronExpressionParser from 'cron-parser';
import { SettingsStore, ScheduleSetting } from './settings';

export interface ScheduleInfo extends ScheduleSetting {
  enabled: boolean;
  description: string;
  nextRun: number | null;
}

/** Runs the scheduled scan; re-applied whenever the schedule is changed in the UI. */
export class Scheduler {
  private task: ScheduledTask | null = null;

  constructor(
    private settings: SettingsStore,
    private onTick: () => void,
  ) {}

  apply(): void {
    this.task?.stop();
    this.task = null;
    const setting = this.settings.schedule();
    if (!setting.cron) {
      console.log(`[${new Date().toISOString()}] Automatic scheduling disabled`);
      return;
    }
    if (!validate(setting.cron)) {
      console.error(`[${new Date().toISOString()}] Invalid cron schedule "${setting.cron}", scheduling disabled`);
      return;
    }
    this.task = schedule(setting.cron, this.onTick, setting.timezone ? { timezone: setting.timezone } : undefined);
    console.log(
      `[${new Date().toISOString()}] Scheduled runs: ${setting.cron}${setting.timezone ? ` (${setting.timezone})` : ''}`,
    );
  }

  info(): ScheduleInfo {
    const setting = this.settings.schedule();
    let description = '';
    let nextRun: number | null = null;
    if (setting.cron) {
      try {
        description =
          setting.mode === 'daily'
            ? `Every day at ${setting.time} (${setting.timezone})`
            : cronstrue.toString(setting.cron);
        const options = setting.timezone ? { tz: setting.timezone } : {};
        nextRun = CronExpressionParser.parse(setting.cron, options).next().toDate().getTime();
      } catch (error) {
        console.error('Error parsing cron schedule:', error);
        description = setting.cron;
      }
    }
    return { ...setting, enabled: setting.cron !== null && this.task !== null, description, nextRun };
  }
}
