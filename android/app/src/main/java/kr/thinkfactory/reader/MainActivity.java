package kr.thinkfactory.reader;

// 생각공작소 문서 리더 — 얇은 네이티브 껍데기.
// 존재 이유: 안드로이드 '연결 앱 / 다른 앱으로 열기' 목록에는 웹앱(PWA)이 등록될 수 없다(구조적 한계).
// 이 앱이 하는 일은 셋뿐이다.
//   ① 파일 인텐트(열기·공유)를 받아 바이트를 웹앱에 넘긴다 (__native_file 가로채기)
//   ② 웹앱이 만든 수정본을 다운로드 폴더에 저장한다 (안드로이드 10+ 는 MediaStore로만 가능)
//   ③ 수정본을 메일·카톡으로 보낸다 (WebView에는 navigator.share가 없다)
// 화면·문서 처리는 전부 웹(reader)이 한다 — 웹을 배포하면 이 앱도 즉시 최신이 된다.

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    private static final String ORIGIN = "think-fact0ry.github.io";
    private static final String BASE = "https://" + ORIGIN + "/reader/";
    private static final int MAX_BYTES = 60 * 1024 * 1024; // 웹앱 상한과 동일

    private WebView web;
    // 인텐트로 받은 파일 — 웹앱이 __native_file 을 요청하면 한 번 건네주고 비운다
    private byte[] pendingBytes;
    private String pendingName = "문서";
    private String pendingMime = "application/octet-stream";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        web.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);   // 확대는 웹앱이 직접 처리한다(브라우저 줌은 표 틀 고정을 깬다)
        s.setBuiltInZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebViewClient(new Client());
        // 브리지는 우리 오리진에서만 의미가 있다 — Client가 다른 호스트를 막고, 브리지 자체도 최소 기능만 노출
        web.addJavascriptInterface(new NativeBridge(), "__native");

        takeFile(getIntent());
        web.loadUrl(pendingBytes != null ? BASE + "?native=1" : BASE);
    }

    @Override
    protected void onNewIntent(Intent intent) {   // 앱이 떠 있는데 다른 파일을 열었을 때
        super.onNewIntent(intent);
        setIntent(intent);
        takeFile(intent);
        if (pendingBytes != null) web.loadUrl(BASE + "?native=1");
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // ───────── 인텐트에서 파일 꺼내기
    private void takeFile(Intent it) {
        if (it == null) return;
        Uri uri = it.getData();
        if (uri == null && Intent.ACTION_SEND.equals(it.getAction())) {
            uri = it.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri == null) return;
        try {
            ContentResolver cr = getContentResolver();
            String type = cr.getType(uri);
            if (type != null && !type.isEmpty()) pendingMime = type;
            pendingName = queryName(cr, uri);
            InputStream in = cr.openInputStream(uri);
            if (in == null) return;
            pendingBytes = readAll(in);
        } catch (Throwable t) {
            pendingBytes = null;
            toast("파일을 읽지 못했어요");
        }
    }

    private String queryName(ContentResolver cr, Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            Cursor c = null;
            try {
                c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
                if (c != null && c.moveToFirst()) {
                    int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (i >= 0) name = c.getString(i);
                }
            } catch (Throwable ignored) {
            } finally {
                if (c != null) c.close();
            }
        }
        if (name == null) name = uri.getLastPathSegment();
        return safeName(name == null ? "문서" : name);
    }

    private static String safeName(String name) {
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash >= 0) name = name.substring(slash + 1);
        name = name.replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_").trim();
        if (name.isEmpty()) name = "문서";
        return name.length() > 120 ? name.substring(name.length() - 120) : name;
    }

    private byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream(65536);
        byte[] buf = new byte[65536];
        int n, total = 0;
        try {
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_BYTES) throw new Exception("too big");
                out.write(buf, 0, n);
            }
        } finally {
            try { in.close(); } catch (Throwable ignored) { }
        }
        return out.toByteArray();
    }

    private void toast(final String msg) {
        runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show());
    }

    // ───────── WebView 클라이언트: 파일 전달 통로 + 외부 링크 차단
    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (u == null || !ORIGIN.equals(u.getHost())) return null;
            String path = u.getPath();
            if (path == null || !path.endsWith("/__native_file")) return null;

            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            if (pendingBytes == null) {
                return new WebResourceResponse("text/plain", "utf-8", 404, "No File",
                        headers, new ByteArrayInputStream(new byte[0]));
            }
            byte[] data = pendingBytes;
            pendingBytes = null; // 한 번만 — 새로고침·뒤로가기로 같은 파일이 중복 등록되지 않게
            headers.put("X-File-Name", Uri.encode(pendingName));
            return new WebResourceResponse(pendingMime, null, 200, "OK",
                    headers, new ByteArrayInputStream(data));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (u == null) return false;
            if (ORIGIN.equals(u.getHost())) return false;   // 우리 앱 안에서 처리
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); return true; }  // 외부 링크는 브라우저로
            catch (Throwable t) { return true; }
        }
    }

    // ───────── 웹 → 네이티브 창구 (저장·보내기만)
    public class NativeBridge {

        /** 웹앱이 만든 수정본을 다운로드 폴더에 저장. 안드로이드 10+는 MediaStore를 거쳐야 한다. */
        @JavascriptInterface
        public void saveBase64(String b64, String name, String mime) {
            try {
                byte[] data = Base64.decode(b64, Base64.DEFAULT);
                String fname = safeName(name);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, fname);
                    cv.put(MediaStore.MediaColumns.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri item = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (item == null) throw new Exception("insert failed");
                    OutputStream os = getContentResolver().openOutputStream(item);
                    if (os == null) throw new Exception("open failed");
                    os.write(data);
                    os.close();
                } else {
                    File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!dir.exists()) dir.mkdirs();
                    FileOutputStream fos = new FileOutputStream(new File(dir, fname));
                    fos.write(data);
                    fos.close();
                }
                toast("다운로드 폴더에 저장했어요 · " + fname);
            } catch (Throwable t) {
                toast("저장하지 못했어요");
            }
        }

        /** 수정본을 메일·카톡 등으로 보내기 (WebView에는 navigator.share가 없다) */
        @JavascriptInterface
        public void shareBase64(String b64, String name, String mime) {
            try {
                byte[] data = Base64.decode(b64, Base64.DEFAULT);
                String fname = safeName(name);
                File dir = new File(getCacheDir(), "share");
                if (!dir.exists()) dir.mkdirs();
                for (File old : dir.listFiles() == null ? new File[0] : dir.listFiles()) old.delete();
                File f = new File(dir, fname);
                FileOutputStream fos = new FileOutputStream(f);
                fos.write(data);
                fos.close();
                Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", f);
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.putExtra(Intent.EXTRA_SUBJECT, fname);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(send, "보내기"));
            } catch (Throwable t) {
                toast("보내지 못했어요");
            }
        }

        /** 웹앱이 "네이티브 앱 안이다"를 확인하는 값 */
        @JavascriptInterface
        public String version() {
            return "1";
        }
    }
}
