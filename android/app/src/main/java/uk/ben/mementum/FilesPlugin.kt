package uk.ben.mementum

import android.content.ContentUris
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.MimeTypeMap
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Saves a file into the phone's public Download folder through MediaStore. Needs no storage
 * permission on Android 10+, and the file shows up in every file picker (e.g. Garmin's importer).
 * On Android 8 and 9 it declines, and native.js falls back to the older Filesystem route / share sheet.
 */
@CapacitorPlugin(name = "MeMentumFiles")
class FilesPlugin : Plugin() {

    @PluginMethod
    fun saveDownload(call: PluginCall) {
        val name = call.getString("name")?.trim().orEmpty()
        val data = call.getString("data")
        // optional sub-folder of Download, e.g. "MeMentum" for automatic backups
        val folder = call.getString("folder")?.trim().orEmpty().replace(Regex("[^A-Za-z0-9 _-]"), "")
        if (name.isEmpty() || data == null) { call.reject("No file to save"); return }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) { call.reject("Needs Android 10 or newer"); return }

        val bytes = try { Base64.decode(data, Base64.DEFAULT) } catch (e: Exception) {
            call.reject("The file data was damaged"); return
        }
        // Take the type from the file's extension (unknown types such as .tcx stay as a plain file),
        // so Android keeps the name exactly as given instead of adding its own extension.
        val ext = name.substringAfterLast('.', "").lowercase()
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"

        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH,
                if (folder.isEmpty()) Environment.DIRECTORY_DOWNLOADS else "${Environment.DIRECTORY_DOWNLOADS}/$folder")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = try {
            resolver.insert(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values)
        } catch (e: Exception) { null }
        if (uri == null) { call.reject("Android wouldn't create the file in Downloads"); return }

        try {
            val out = resolver.openOutputStream(uri) ?: throw IllegalStateException("Couldn't open the file")
            out.use { it.write(bytes) }
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)

            // Android renames clashes ("file (1).tcx"), so report the name it actually used.
            var saved = name
            resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0)?.let { saved = it }
            }
            val ret = JSObject()
            ret.put("name", saved)
            ret.put("uri", uri.toString())
            call.resolve(ret)
        } catch (e: Exception) {
            try { resolver.delete(uri, null, null) } catch (ignored: Exception) {}
            call.reject(e.message ?: "Couldn't save the file")
        }
    }

    /**
     * Deletes all but the newest `keep` files in Download/<folder> whose names start with `prefix`.
     * Android only lets the app see and delete files it created itself, so anything else is left alone.
     */
    @PluginMethod
    fun prune(call: PluginCall) {
        val folder = call.getString("folder")?.trim().orEmpty().replace(Regex("[^A-Za-z0-9 _-]"), "")
        val prefix = call.getString("prefix")?.trim().orEmpty()
        val keep = maxOf(1, call.getInt("keep", 8) ?: 8)
        val ret = JSObject()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || folder.isEmpty() || prefix.isEmpty()) {
            ret.put("removed", 0); call.resolve(ret); return
        }
        val uri = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        var removed = 0
        try {
            context.contentResolver.query(
                uri, arrayOf(MediaStore.MediaColumns._ID),
                "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?",
                arrayOf("${Environment.DIRECTORY_DOWNLOADS}/$folder/", "$prefix%"),
                "${MediaStore.MediaColumns.DATE_ADDED} DESC"
            )?.use { c ->
                var i = 0
                while (c.moveToNext()) {
                    if (i++ < keep) continue
                    try {
                        if (context.contentResolver.delete(ContentUris.withAppendedId(uri, c.getLong(0)), null, null) > 0) removed++
                    } catch (ignored: Exception) {}
                }
            }
        } catch (ignored: Exception) {}
        ret.put("removed", removed)
        call.resolve(ret)
    }
}
