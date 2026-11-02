package com.wbtv.tv

import android.app.AlarmManager
import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

/**
 * Crash recovery for a TV that is left running: if the app ever dies from an unexpected error, relaunch it a moment later
 * (it resumes the last channel). A crash loop (more than 3 crashes in 2 minutes) is left alone rather than flapping forever.
 */
class WbtvApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try { scheduleRestart() } catch (_: Throwable) { /* never get in the way of the normal crash path */ }
            previous?.uncaughtException(thread, error)
        }
    }

    private fun scheduleRestart() {
        val sp = getSharedPreferences("wbtv_crash", Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val recent = (sp.getString("t", "") ?: "").split(',').mapNotNull { it.toLongOrNull() }.filter { now - it < 120_000 } + now
        sp.edit().putString("t", recent.joinToString(",")).commit()
        if (recent.size > 3) return
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        val pi = PendingIntent.getActivity(this, 1, launch, PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE)
        (getSystemService(Context.ALARM_SERVICE) as AlarmManager).set(AlarmManager.RTC, now + 1500, pi)
    }
}
