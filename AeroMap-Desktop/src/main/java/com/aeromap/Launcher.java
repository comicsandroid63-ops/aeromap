package com.aeromap;

public class Launcher {
    public static void main(String[] args) {
        // CRITICAL: These properties MUST be set before ANY class from JAI or GeoTools
        // is loaded. If javax.media.jai.JAI initializes with native medialib missing,
        // it throws ExceptionInInitializerError and crashes the entire app.
        System.setProperty("com.sun.media.jai.disableMediaLib", "true");
        System.setProperty("javax.media.jai.imageiocache", "false");
        System.setProperty("com.sun.media.imageio.disableNativeCode", "true");
        System.setProperty("org.geotools.referencing.forceXY", "true");
        
        App.main(args);
    }
}
