"use strict"

path = require('path')

module.exports = (grunt) ->
  
  # Project Configuration
  grunt.initConfig
    pkg: grunt.file.readJSON("package.json")
    
    notify_hooks: 
      options:
        enabled: true
        title: "Network-Manager"

    watch:
      coffee:
        files: ["src/**/*.coffee"]
        tasks: ["newer:coffee:src", "notify:coffee"]

    notify:
      coffee:
        options:
          message: 'Coffeescript has finished compiling'

      compiling:
        options:
          message: 'Finished Compiling'

    coffee:
      src:
        options:
          # No wrapper js
          bare: true
        expand: true
        flatten: false
        cwd: 'src/'
        src: '**/*.coffee'
        dest: 'lib/'
        ext: '.js'
  
  #Load NPM tasks 
  grunt.loadNpmTasks "grunt-contrib-watch"
  grunt.loadNpmTasks "grunt-contrib-coffee"
  grunt.loadNpmTasks "grunt-newer"
  grunt.loadNpmTasks "grunt-notify"
  
  #Making grunt default to force in order not to break the project.
  # grunt.option "force", true
  
  #Default task(s).
  grunt.registerTask "default", [
    "coffee"
    "watch"
  ]

  return
