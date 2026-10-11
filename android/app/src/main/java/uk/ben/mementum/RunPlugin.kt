package uk.ben.mementum

import android.content.Intent
import androidx.core.content.ContextCompat
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** start / update / stop the "Run in progress" foreground service from JavaScript. */
@CapacitorPlugin(name = "MeMentumRun")
class RunPlugin : Plugin() {

    private fun intent(call: PluginCall) = Intent(context, RunService::class.java)
        .putExtra(RunService.EXTRA_TITLE, call.getString("title", "Run in progress"))
        .putExtra(RunService.EXTRA_TEXT, call.getString("text", ""))

    @PluginMethod
    fun start(call: PluginCall) {
        try {
            ContextCompat.startForegroundService(context, intent(call))
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: "Couldn't start the run notification")
        }
    }

    @PluginMethod
    fun update(call: PluginCall) {
        if (!RunService.running) { call.resolve(); return }
        try {
            context.startService(intent(call))
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: "Couldn't update the run notification")
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        context.stopService(Intent(context, RunService::class.java))
        call.resolve()
    }
}
