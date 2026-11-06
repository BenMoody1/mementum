package uk.ben.mementum

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ElevationGainedRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SpeedRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Velocity
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.time.Instant
import java.time.ZoneId
import kotlin.reflect.KClass
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Writes finished MeMentum runs to Health Connect as a treadmill-running exercise
 * session plus distance, active calories, heart rate, speed, climb and (optionally) steps.
 * Every record gets a clientRecordId of "mementum-<runId>-<kind>", so writing the same
 * run again updates it instead of creating a duplicate.
 *
 * It also reads weigh-ins (from Renpho Health or any other scale app that shares weight with
 * Health Connect). Weight has its own permission, asked for separately, so turning on weight
 * import never depends on run sync and the other way round.
 *
 * Walks and runs recorded by other apps (Garmin Connect and the like) can be listed with
 * readActivities. Nothing is saved from here: the app shows them for review and only keeps the
 * ones the person approves. Reading them needs its own read permissions, asked for separately.
 */
@CapacitorPlugin(name = "MeMentumHealth")
class HealthConnectPlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var launcher: ActivityResultLauncher<Set<String>>? = null
    private var pending: PluginCall? = null

    private val kinds: Map<KClass<out Record>, String> = linkedMapOf(
        ExerciseSessionRecord::class to "session",
        DistanceRecord::class to "distance",
        ActiveCaloriesBurnedRecord::class to "calories",
        HeartRateRecord::class to "heartrate",
        SpeedRecord::class to "speed",
        ElevationGainedRecord::class to "climb",
        StepsRecord::class to "steps"
    )
    private val permissions: Set<String>
        get() = kinds.keys.map { HealthPermission.getWritePermission(it) }.toSet()
    private val weightPermission = HealthPermission.getReadPermission(WeightRecord::class)
    private val sessionRead = HealthPermission.getReadPermission(ExerciseSessionRecord::class)
    private val activityReads: Set<String> = setOf(
        ExerciseSessionRecord::class, DistanceRecord::class, StepsRecord::class,
        HeartRateRecord::class, ActiveCaloriesBurnedRecord::class
    ).map { HealthPermission.getReadPermission(it) }.toSet()
    private val activityTypes = mapOf(
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING to "walk",
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING to "run",
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL to "treadmill",
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING to "hike"
    )

    private fun available() = HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE
    private fun client() = HealthConnectClient.getOrCreate(context)

    override fun load() {
        try {
            launcher = activity.registerForActivityResult(
                PermissionController.createRequestPermissionResultContract()
            ) { _ -> pending?.let { pending = null; status(it) } }
        } catch (e: Exception) {
            Log.w(TAG, "Falling back to startActivityForResult for permissions", e)
            launcher = null
        }
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val sdk = HealthConnectClient.getSdkStatus(context)
        val ret = JSObject()
        ret.put("available", when (sdk) {
            HealthConnectClient.SDK_AVAILABLE -> "available"
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update_required"
            else -> "unavailable"
        })
        if (sdk != HealthConnectClient.SDK_AVAILABLE) {
            ret.put("granted", JSArray())
            call.resolve(ret)
            return
        }
        scope.launch {
            try {
                val granted = client().permissionController.getGrantedPermissions()
                val names = JSArray()
                kinds.forEach { (type, kind) -> if (granted.contains(HealthPermission.getWritePermission(type))) names.put(kind) }
                if (granted.contains(weightPermission)) names.put("weight")
                if (granted.contains(sessionRead)) names.put("activities")
                ret.put("granted", names)
                call.resolve(ret)
            } catch (e: Exception) {
                call.reject(e.message ?: "Couldn't read Health Connect permissions")
            }
        }
    }

    @PluginMethod
    fun requestAccess(call: PluginCall) {
        if (!available()) { call.reject("Health Connect isn't available on this phone"); return }
        // { weight: true } asks only for reading weight, { activities: true } only for reading
        // other apps' walks and runs; otherwise the run-writing permissions
        val wanted = when {
            call.getBoolean("weight", false) == true -> setOf(weightPermission)
            call.getBoolean("activities", false) == true -> activityReads
            else -> permissions
        }
        val l = launcher
        if (l != null) {
            pending = call
            l.launch(wanted)
        } else {
            val intent = PermissionController.createRequestPermissionResultContract().createIntent(context, wanted)
            startActivityForResult(call, intent, "accessResult")
        }
    }

    @ActivityCallback
    private fun accessResult(call: PluginCall?, result: ActivityResult) {
        if (call != null) status(call)
    }

    @PluginMethod
    fun writeRuns(call: PluginCall) {
        if (!available()) { call.reject("Health Connect isn't available on this phone"); return }
        val runs = call.getArray("runs") ?: JSArray()
        val includeSteps = call.getBoolean("includeSteps", false) ?: false
        scope.launch {
            try {
                val granted = client().permissionController.getGrantedPermissions()
                val can = { t: KClass<out Record> -> granted.contains(HealthPermission.getWritePermission(t)) }
                if (!can(ExerciseSessionRecord::class)) { call.reject("NO_PERMISSION"); return@launch }
                var written = 0
                val failed = JSArray()
                for (i in 0 until runs.length()) {
                    val run = runs.getJSONObject(i)
                    try {
                        client().insertRecords(build(run, includeSteps, can))
                        written++
                    } catch (e: Exception) {
                        Log.e(TAG, "Couldn't write run ${run.optString("id")}", e)
                        failed.put(run.optString("id"))
                    }
                }
                val ret = JSObject()
                ret.put("written", written)
                ret.put("failed", failed)
                call.resolve(ret)
            } catch (e: Exception) {
                call.reject(e.message ?: "Couldn't write to Health Connect")
            }
        }
    }

    @PluginMethod
    fun deleteRuns(call: PluginCall) {
        if (!available()) { call.resolve(); return }
        val ids = call.getArray("ids") ?: JSArray()
        val list = (0 until ids.length()).map { ids.getString(it) }
        scope.launch {
            kinds.forEach { (type, kind) ->
                try {
                    client().deleteRecords(type, emptyList(), list.map { "mementum-$it-$kind" })
                } catch (e: Exception) {
                    Log.w(TAG, "Delete skipped for $kind", e)
                }
            }
            call.resolve()
        }
    }

    /**
     * Weigh-ins recorded after `since` (ms). Resolves { weights: [{ time, day, kg, source }] },
     * oldest first. `day` is the local date the weigh-in was taken on (YYYY-MM-DD).
     * Health Connect only lets an app read back to 30 days before it was first given access.
     */
    @PluginMethod
    fun readWeights(call: PluginCall) {
        if (!available()) { call.reject("Health Connect isn't available on this phone"); return }
        val since = Instant.ofEpochMilli(maxOf(0L, call.getLong("since", 0L) ?: 0L))
        scope.launch {
            try {
                if (!client().permissionController.getGrantedPermissions().contains(weightPermission)) {
                    call.reject("NO_PERMISSION"); return@launch
                }
                val out = JSArray()
                var token: String? = null
                var pages = 0
                do {
                    val res = client().readRecords(ReadRecordsRequest(
                        recordType = WeightRecord::class,
                        timeRangeFilter = TimeRangeFilter.after(since),
                        ascendingOrder = true,
                        pageSize = 500,
                        pageToken = token
                    ))
                    res.records.forEach { w ->
                        val zone = w.zoneOffset ?: ZoneId.systemDefault().rules.getOffset(w.time)
                        val o = JSObject()
                        o.put("time", w.time.toEpochMilli())
                        o.put("day", w.time.atOffset(zone).toLocalDate().toString())
                        o.put("kg", w.weight.inKilograms)
                        o.put("source", w.metadata.dataOrigin.packageName)
                        out.put(o)
                    }
                    token = res.pageToken
                    pages++
                } while (!token.isNullOrEmpty() && pages < 20)
                val ret = JSObject()
                ret.put("weights", out)
                call.resolve(ret)
            } catch (e: Exception) {
                Log.e(TAG, "Couldn't read weight", e)
                call.reject(e.message ?: "Couldn't read weight from Health Connect")
            }
        }
    }

    /**
     * Walks, runs and hikes other apps wrote to Health Connect after `since` (ms), newest first.
     * MeMentum's own runs are left out. Resolves { activities: [{ id, source, type, title, start,
     * end, distance (m), steps, avgHr, maxHr, kcal }] }. Totals come only from the app that recorded
     * the session; any it didn't record, or whose permission was refused, are left out (not 0).
     */
    @PluginMethod
    fun readActivities(call: PluginCall) {
        if (!available()) { call.reject("Health Connect isn't available on this phone"); return }
        val since = Instant.ofEpochMilli(maxOf(0L, call.getLong("since", 0L) ?: 0L))
        scope.launch {
            try {
                val granted = client().permissionController.getGrantedPermissions()
                if (!granted.contains(sessionRead)) { call.reject("NO_PERMISSION"); return@launch }
                val own = context.packageName
                val sessions = mutableListOf<ExerciseSessionRecord>()
                var token: String? = null
                var pages = 0
                do {
                    val res = client().readRecords(ReadRecordsRequest(
                        recordType = ExerciseSessionRecord::class,
                        timeRangeFilter = TimeRangeFilter.after(since),
                        ascendingOrder = false,
                        pageSize = 200,
                        pageToken = token
                    ))
                    res.records.filterTo(sessions) {
                        it.metadata.dataOrigin.packageName != own && activityTypes.containsKey(it.exerciseType)
                    }
                    token = res.pageToken
                    pages++
                } while (!token.isNullOrEmpty() && pages < 10)

                val can = { t: KClass<out Record> -> granted.contains(HealthPermission.getReadPermission(t)) }
                val out = JSArray()
                for (s in sessions.take(100)) {
                    val o = JSObject()
                    o.put("id", s.metadata.id)
                    o.put("source", s.metadata.dataOrigin.packageName)
                    o.put("type", activityTypes[s.exerciseType])
                    o.put("title", s.title ?: "")
                    o.put("start", s.startTime.toEpochMilli())
                    o.put("end", s.endTime.toEpochMilli())
                    // Raw records from the same app, added up here. Health Connect's own totals follow
                    // its data-source priority list and can leave the watch's figures out.
                    val origin = setOf(s.metadata.dataOrigin)
                    val win = TimeRangeFilter.between(s.startTime, s.endTime)
                    // share of a record that falls inside the session, for records that run past it
                    fun part(a: Instant, b: Instant): Double {
                        val len = b.toEpochMilli() - a.toEpochMilli()
                        if (len <= 0) return 1.0
                        val ov = minOf(b, s.endTime).toEpochMilli() - maxOf(a, s.startTime).toEpochMilli()
                        return (ov.toDouble() / len).coerceIn(0.0, 1.0)
                    }
                    try {
                        if (can(DistanceRecord::class)) {
                            val recs = readAll(DistanceRecord::class, win, origin)
                            if (recs.isNotEmpty()) o.put("distance", recs.sumOf { it.distance.inMeters * part(it.startTime, it.endTime) })
                        }
                        if (can(StepsRecord::class)) {
                            val recs = readAll(StepsRecord::class, win, origin)
                            if (recs.isNotEmpty()) o.put("steps", recs.sumOf { it.count * part(it.startTime, it.endTime) })
                        }
                        if (can(ActiveCaloriesBurnedRecord::class)) {
                            val recs = readAll(ActiveCaloriesBurnedRecord::class, win, origin)
                            if (recs.isNotEmpty()) o.put("kcal", recs.sumOf { it.energy.inKilocalories * part(it.startTime, it.endTime) })
                        }
                        if (can(HeartRateRecord::class)) {
                            val bpm = readAll(HeartRateRecord::class, win, origin).flatMap { it.samples }
                                .filter { !it.time.isBefore(s.startTime) && !it.time.isAfter(s.endTime) }
                                .map { it.beatsPerMinute }
                            if (bpm.isNotEmpty()) { o.put("avgHr", bpm.average()); o.put("maxHr", bpm.maxOrNull()) }
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "Couldn't total activity ${s.metadata.id}", e)
                    }
                    out.put(o)
                }
                val ret = JSObject()
                ret.put("activities", out)
                call.resolve(ret)
            } catch (e: Exception) {
                Log.e(TAG, "Couldn't read activities", e)
                call.reject(e.message ?: "Couldn't read activities from Health Connect")
            }
        }
    }

    private suspend fun <T : Record> readAll(type: KClass<T>, range: TimeRangeFilter, origin: Set<DataOrigin>): List<T> {
        val out = mutableListOf<T>()
        var token: String? = null
        var pages = 0
        do {
            val res = client().readRecords(ReadRecordsRequest(
                recordType = type, timeRangeFilter = range, dataOriginFilter = origin,
                pageSize = 1000, pageToken = token
            ))
            out += res.records
            token = res.pageToken
            pages++
        } while (!token.isNullOrEmpty() && pages < 10)
        return out
    }

    @PluginMethod
    fun openSettings(call: PluginCall) {
        val intent = if (HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED)
            Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.apps.healthdata&url=healthconnect%3A%2F%2Fonboarding"))
        else Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
        try {
            activity.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Couldn't open Health Connect")
        }
    }

    private fun build(r: JSONObject, includeSteps: Boolean, can: (KClass<out Record>) -> Boolean): List<Record> {
        val id = r.getString("id")
        val start = Instant.ofEpochMilli(r.getLong("start"))
        val duration = maxOf(1L, r.optLong("duration", 0L))
        val end = start.plusSeconds(duration)
        val rules = ZoneId.systemDefault().rules
        val so = rules.getOffset(start)
        val eo = rules.getOffset(end)
        val version = r.optLong("version", 1L)
        val device = Device(type = Device.TYPE_PHONE)
        fun meta(kind: String) = Metadata.activelyRecorded(
            clientRecordId = "mementum-$id-$kind",
            clientRecordVersion = version,
            device = device
        )
        val out = mutableListOf<Record>()

        val title = r.optString("title", "").ifBlank { "Treadmill run" }
        val notes = r.optString("notes", "").ifBlank { null }
        out += ExerciseSessionRecord(
            startTime = start, startZoneOffset = so, endTime = end, endZoneOffset = eo,
            metadata = meta("session"),
            exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL,
            title = title, notes = notes
        )

        val dist = r.optDouble("distance", 0.0)
        if (dist > 0 && can(DistanceRecord::class)) out += DistanceRecord(
            startTime = start, startZoneOffset = so, endTime = end, endZoneOffset = eo,
            distance = Length.meters(dist), metadata = meta("distance")
        )

        val kcal = r.optDouble("kcal", 0.0)
        if (kcal > 0 && can(ActiveCaloriesBurnedRecord::class)) out += ActiveCaloriesBurnedRecord(
            startTime = start, startZoneOffset = so, endTime = end, endZoneOffset = eo,
            energy = Energy.kilocalories(kcal), metadata = meta("calories")
        )

        val climb = r.optDouble("climb", 0.0)
        if (climb > 0 && can(ElevationGainedRecord::class)) out += ElevationGainedRecord(
            startTime = start, startZoneOffset = so, endTime = end, endZoneOffset = eo,
            elevation = Length.meters(climb), metadata = meta("climb")
        )

        val steps = r.optLong("steps", 0L)
        if (includeSteps && steps > 0 && can(StepsRecord::class)) out += StepsRecord(
            startTime = start, startZoneOffset = so, endTime = end, endZoneOffset = eo,
            count = steps, metadata = meta("steps")
        )

        val hrArr = r.optJSONArray("hr")
        if (hrArr != null && can(HeartRateRecord::class)) {
            val samples = (0 until hrArr.length()).mapNotNull { i ->
                val p = hrArr.getJSONArray(i)
                val t = p.getLong(0); val bpm = p.getLong(1)
                if (t in 0 until duration && bpm in 1..300) HeartRateRecord.Sample(start.plusSeconds(t), bpm) else null
            }.distinctBy { it.time }
            if (samples.isNotEmpty()) out += HeartRateRecord(
                startTime = start, startZoneOffset = so, endTime = end, endZoneOffset = eo,
                samples = samples, metadata = meta("heartrate")
            )
        }

        val spArr = r.optJSONArray("speed")
        if (spArr != null && can(SpeedRecord::class)) {
            val samples = (0 until spArr.length()).mapNotNull { i ->
                val p = spArr.getJSONArray(i)
                val t = p.getLong(0); val kmh = p.getDouble(1)
                if (t in 0 until duration && kmh >= 0 && kmh < 100) SpeedRecord.Sample(start.plusSeconds(t), Velocity.kilometersPerHour(kmh)) else null
            }.distinctBy { it.time }
            if (samples.isNotEmpty()) out += SpeedRecord(
                startTime = start, startZoneOffset = so, endTime = end, endZoneOffset = eo,
                samples = samples, metadata = meta("speed")
            )
        }
        return out
    }

    companion object {
        private const val TAG = "MeMentumHealth"
    }
}
