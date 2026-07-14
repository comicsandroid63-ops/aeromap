package com.tiffpreview;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

import javax.imageio.ImageIO;

@SpringBootApplication
public class TiffPreviewApplication {

    static {
        ImageIO.scanForPlugins();
    }

    public static void main(String[] args) {
        SpringApplication.run(TiffPreviewApplication.class, args);
    }
}
